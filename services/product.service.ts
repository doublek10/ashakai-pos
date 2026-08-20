import { PaymentProviderName, PaymentMethod } from '@prisma/client';
import { prisma } from '@/lib/database/client';
import { recordAudit } from '@/lib/audit';
import { ApiError } from '@/lib/permissions/guard';
import { CartLineInput, createSale, completeSaleFromPayment } from '@/services/sales.service';
import { PaymentProvider } from '@/lib/payments/payment-provider';
import { MpesaProvider } from '@/lib/payments/mpesa/provider';
import { PesapalProvider } from '@/lib/payments/pesapal/provider';
import { CardProvider } from '@/lib/payments/cards/provider';

// ============================================================
// DIGITAL PAYMENTS (M-Pesa / PesaPal / Card)
// ------------------------------------------------------------
// PHP-gateway counterpart: gateway/payments/_cart_pricing.php,
// gateway/payments/_sale_completion.php and
// gateway/webhooks/mpesa_callback.php — keep the two in sync if you
// change one. See lib/payments/payment-provider.ts for the shared
// gateway contract.
// ============================================================

type DigitalProviderName = Exclude<PaymentProviderName, 'CASH'>;

/** Resolves the SDK adapter for a given provider. Never call this with 'CASH' — cash never talks to a gateway. */
export function getProvider(name: DigitalProviderName): PaymentProvider {
  switch (name) {
    case 'MPESA':
      return new MpesaProvider();
    case 'PESAPAL':
      return new PesapalProvider();
    case 'CARD':
      return new CardProvider();
    default:
      throw new ApiError(400, `Unsupported payment provider: ${name}`);
  }
}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

function callbackUrlFor(provider: DigitalProviderName): string {
  switch (provider) {
    case 'MPESA':
      return process.env.MPESA_CALLBACK_URL || `${appUrl()}/api/webhooks/mpesa`;
    case 'PESAPAL':
      return process.env.PESAPAL_IPN_URL || `${appUrl()}/api/webhooks/pesapal`;
    case 'CARD':
      return `${appUrl()}/api/webhooks/cards/${process.env.CARD_PROVIDER || 'default'}`;
  }
}

const SHORT_REF_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O or 1/I — this may be read off a phone screen
function shortMerchantReference(): string {
  let suffix = '';
  for (let i = 0; i < 3; i++) {
    suffix += SHORT_REF_CHARS[Math.floor(Math.random() * SHORT_REF_CHARS.length)];
  }
  return `ashekia-${suffix}`;
}

/**
 * Opens a PENDING payment_transactions row with a short, collision-safe
 * "ashekia-XXX" reference (Daraja's AccountReference field truncates
 * anything over 12 chars, so this stays short for every provider).
 */
async function openPaymentTransaction(params: {
  companyId: string;
  saleId: string;
  provider: DigitalProviderName;
  paymentMethod: PaymentMethod;
  amount: number;
  phone?: string;
  email?: string;
}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const merchantReference = shortMerchantReference();
    try {
      return await prisma.paymentTransaction.create({
        data: {
          companyId: params.companyId,
          saleId: params.saleId,
          provider: params.provider,
          paymentMethod: params.paymentMethod,
          merchantReference,
          amount: params.amount,
          currency: 'KES',
          status: 'PENDING',
          customerPhone: params.phone,
          customerEmail: params.email,
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') continue; // merchantReference collision — retry with a new one
      throw err;
    }
  }
  throw new ApiError(500, 'Could not generate a unique payment reference — please retry');
}

export interface InitiateDigitalPaymentInput {
  companyId: string;
  branchId: string;
  cashierId: string; // ALWAYS taken from the session — see sales.service.ts
  customerId?: string;
  items: CartLineInput[];
  provider: DigitalProviderName;
  paymentMethod: PaymentMethod;
  phone?: string; // required for M-Pesa STK push
  email?: string; // required for PesaPal / card receipts
}

/**
 * Prices the cart and creates a PENDING sale (no stock touched — see
 * createSale()), opens a matching PENDING payment_transactions row,
 * then kicks off the actual STK push / hosted-checkout / payment
 * intent with the provider. The sale is only completed once the
 * provider's webhook confirms payment — see processPaymentWebhook()
 * and sales.service.ts completeSaleFromPayment().
 */
export async function initiateDigitalPayment(input: InitiateDigitalPaymentInput) {
  const sale = await createSale({
    companyId: input.companyId,
    branchId: input.branchId,
    cashierId: input.cashierId,
    customerId: input.customerId,
    items: input.items,
    // no cashPayments — this keeps the sale PENDING for the webhook to complete
  });

  const transaction = await openPaymentTransaction({
    companyId: input.companyId,
    saleId: sale.id,
    provider: input.provider,
    paymentMethod: input.paymentMethod,
    amount: Number(sale.total),
    phone: input.phone,
    email: input.email,
  });

  const provider = getProvider(input.provider);

  let providerResult;
  try {
    providerResult = await provider.createPayment({
      merchantReference: transaction.merchantReference,
      amount: Number(sale.total),
      currency: 'KES',
      phone: input.phone,
      email: input.email,
      description: `Sale ${sale.id}`,
      callbackUrl: callbackUrlFor(input.provider),
    });
  } catch (err) {
    // Don't leave a PENDING row behind for an attempt the provider never
    // actually accepted — nothing will ever call back to complete it.
    await prisma.paymentTransaction.update({
      where: { id: transaction.id },
      data: { status: 'FAILED' },
    });
    throw err;
  }

  const updatedTransaction = await prisma.paymentTransaction.update({
    where: { id: transaction.id },
    data: {
      providerReference: providerResult.providerReference,
      rawResponse: providerResult.raw as any,
    },
  });

  return { sale, transaction: updatedTransaction, redirectUrl: providerResult.redirectUrl };
}

export interface ProcessPaymentWebhookInput {
  providerName: DigitalProviderName;
  externalEventId: string;
  eventType: string;
  merchantReference: string;
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED';
  amount: number;
  providerReference?: string;
  raw: unknown;
}

/**
 * Handles an incoming webhook/callback/IPN, already parsed + signature-
 * verified by the caller (see PaymentProvider.verifyWebhook). Matches
 * payment_events' unique (provider, externalEventId) constraint for
 * idempotency — a duplicate delivery of the exact same notification is
 * a safe no-op — and only ever completes the sale once, no matter how
 * many times a provider retries delivery.
 */
export async function processPaymentWebhook(input: ProcessPaymentWebhookInput) {
  // Some providers (Daraja in particular) don't reliably echo our own
  // merchantReference back, so we also match on providerReference —
  // set right after createPayment() was accepted in initiateDigitalPayment.
  const txn = await prisma.paymentTransaction.findFirst({
    where: {
      provider: input.providerName,
      OR: [
        { merchantReference: input.merchantReference },
        { providerReference: input.merchantReference },
      ],
    },
  });

  if (!txn) {
    console.error(
      `[payment webhook] no ${input.providerName} transaction found for reference ${input.merchantReference}`
    );
    return;
  }

  try {
    await prisma.paymentEvent.create({
      data: {
        paymentTransactionId: txn.id,
        provider: input.providerName,
        eventType: input.eventType,
        externalEventId: input.externalEventId,
        payload: input.raw as any,
      },
    });
  } catch (err: any) {
    if (err?.code === 'P2002') return; // already processed this exact notification
    throw err;
  }

  // Never trust the webhook's status claim alone — the amount must match
  // what we actually opened the transaction for.
  const amountMatches = Math.abs(input.amount - Number(txn.amount)) < 1;
  const finalStatus = input.status === 'COMPLETED' && !amountMatches ? 'FAILED' : input.status;

  await prisma.paymentTransaction.update({
    where: { id: txn.id },
    data: {
      status: finalStatus,
      providerReference: input.providerReference ?? txn.providerReference,
      rawResponse: input.raw as any,
    },
  });

  if (finalStatus === 'COMPLETED' && txn.saleId) {
    const sale = await prisma.sale.findUnique({
      where: { id: txn.saleId },
      select: { branchId: true, cashierId: true },
    });
    if (sale) {
      await completeSaleFromPayment({
        saleId: txn.saleId,
        method: txn.paymentMethod,
        amount: Number(txn.amount),
        reference: input.providerReference ?? input.externalEventId,
        cashierId: sale.cashierId,
        branchId: sale.branchId,
        companyId: txn.companyId,
      });
    }
  }

  await prisma.paymentEvent.updateMany({
    where: { paymentTransactionId: txn.id, externalEventId: input.externalEventId },
    data: { processed: true, processedAt: new Date() },
  });
}

// ============================================================
// PRODUCTS
// ============================================================

export interface CreateProductInput {
  companyId: string;
  actorUserId: string;
  categoryId?: string;
  brandId?: string;
  name: string;
  description?: string;
  sku: string;
  costPrice: number;
  sellingPrice: number;
  taxRate?: number;
  /** Whole-unit reorder point for PIECE products, or a weight threshold (in weightUnit) for WEIGHT products. */
  reorderLevel?: number;
  unit?: string;
  /** PIECE (default) = countable units. WEIGHT = sold/stocked by weight (loose cereal, grain, flour). */
  trackingType?: 'PIECE' | 'WEIGHT';
  /** Only used when trackingType = WEIGHT. "kg" or "g". Defaults to "kg". */
  weightUnit?: 'kg' | 'g';
  imageUrl?: string;
  barcodes?: string[];
}

export async function createProduct(input: CreateProductInput) {
  const existing = await prisma.product.findUnique({
    where: { companyId_sku: { companyId: input.companyId, sku: input.sku } },
  });
  if (existing) {
    throw new ApiError(409, `A product with SKU "${input.sku}" already exists`);
  }

  const cleanBarcodes = input.barcodes
    ?.map((b) => b.trim())
    .filter((b) => b.length > 0);

  try {
    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          companyId: input.companyId,
          categoryId: input.categoryId,
          brandId: input.brandId,
          name: input.name,
          description: input.description,
          sku: input.sku,
          costPrice: input.costPrice,
          sellingPrice: input.sellingPrice,
          taxRate: input.taxRate ?? 0,
          reorderLevel: input.reorderLevel ?? 0,
          unit: input.unit ?? (input.trackingType === 'WEIGHT' ? (input.weightUnit ?? 'kg') : 'pcs'),
          trackingType: input.trackingType ?? 'PIECE',
          weightUnit: input.trackingType === 'WEIGHT' ? (input.weightUnit ?? 'kg') : null,
          imageUrl: input.imageUrl,
          barcodes: cleanBarcodes?.length
            ? { create: cleanBarcodes.map((barcode) => ({ barcode })) }
            : undefined,
        },
        include: { barcodes: true },
      });

      await recordAudit(tx, {
        companyId: input.companyId,
        userId: input.actorUserId,
        action: 'PRODUCT_CREATED',
        entity: 'Product',
        entityId: created.id,
        newData: created,
      });

      return created;
    });

    return product;
  } catch (err: any) {
    // Unique constraint on ProductBarcode.barcode — same barcode
    // already belongs to another product (barcodes are unique
    // company-wide, same as a UPC/EAN would be in real life).
    if (err?.code === 'P2002') {
      throw new ApiError(409, 'One of those barcodes is already in use by another product');
    }
    throw err;
  }
}

export interface UpdateProductInput {
  companyId: string;
  actorUserId: string;
  productId: string;
  data: Partial<{
    name: string;
    description: string;
    categoryId: string;
    brandId: string;
    costPrice: number;
    sellingPrice: number;
    taxRate: number;
    reorderLevel: number;
    unit: string;
    trackingType: 'PIECE' | 'WEIGHT';
    weightUnit: 'kg' | 'g';
    imageUrl: string;
    isActive: boolean;
    /** When provided, REPLACES the product's entire set of barcodes — not a merge/append. */
    barcodes: string[];
  }>;
}

export async function updateProduct(input: UpdateProductInput) {
  const before = await prisma.product.findFirst({
    where: { id: input.productId, companyId: input.companyId },
  });
  if (!before) throw new ApiError(404, 'Product not found');

  const priceChanged =
    input.data.sellingPrice !== undefined &&
    Number(before.sellingPrice) !== input.data.sellingPrice;

  // barcodes isn't a column on Product — it's a separate relation, so
  // it's pulled out of `data` and handled with its own delete+create
  // below rather than being passed straight to product.update().
  const { barcodes, ...rest } = input.data;
  const data = { ...rest };
  // If the product is being switched to PIECE tracking, drop any
  // leftover weightUnit; if switched to WEIGHT with no unit given,
  // default to kg.
  if (data.trackingType === 'PIECE') data.weightUnit = null as any;
  if (data.trackingType === 'WEIGHT' && !data.weightUnit) data.weightUnit = 'kg';

  const cleanBarcodes = barcodes
    ?.map((b) => b.trim())
    .filter((b) => b.length > 0);

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const product = await tx.product.update({
        where: { id: input.productId },
        data,
      });

      // Replace-the-whole-set semantics: clear what's there, then
      // re-create whatever the form submitted. Simpler and safer than
      // diffing add/remove, and matches gateway/products/update.php.
      if (cleanBarcodes) {
        await tx.productBarcode.deleteMany({ where: { productId: input.productId } });
        if (cleanBarcodes.length > 0) {
          await tx.productBarcode.createMany({
            data: cleanBarcodes.map((barcode) => ({ productId: input.productId, barcode })),
          });
        }
      }

      await recordAudit(tx, {
        companyId: input.companyId,
        userId: input.actorUserId,
        action: priceChanged ? 'PRODUCT_PRICE_CHANGED' : 'PRODUCT_UPDATED',
        entity: 'Product',
        entityId: product.id,
        oldData: before,
        newData: product,
      });

      return product;
    });

    return updated;
  } catch (err: any) {
    if (err?.code === 'P2002') {
      throw new ApiError(409, 'One of those barcodes is already in use by another product');
    }
    throw err;
  }
}

/** Deactivate rather than hard-delete — sale history references products by id. */
export async function deactivateProduct(companyId: string, actorUserId: string, productId: string) {
  const before = await prisma.product.findFirst({ where: { id: productId, companyId } });
  if (!before) throw new ApiError(404, 'Product not found');

  return prisma.$transaction(async (tx) => {
    const product = await tx.product.update({
      where: { id: productId },
      data: { isActive: false },
    });
    await recordAudit(tx, {
      companyId,
      userId: actorUserId,
      action: 'PRODUCT_DEACTIVATED',
      entity: 'Product',
      entityId: productId,
      oldData: before,
      newData: product,
    });
    return product;
  });
}

export async function listProducts(companyId: string, opts: { search?: string; branchId?: string } = {}) {
  return prisma.product.findMany({
    where: {
      companyId,
      isActive: true,
      ...(opts.search
        ? {
            OR: [
              { name: { contains: opts.search, mode: 'insensitive' } },
              { sku: { contains: opts.search, mode: 'insensitive' } },
              { barcodes: { some: { barcode: opts.search } } },
            ],
          }
        : {}),
    },
    include: {
      barcodes: true,
      category: true,
      brand: true,
      inventory: opts.branchId ? { where: { branchId: opts.branchId } } : true,
    },
    orderBy: { name: 'asc' },
    take: 200,
  });
}

/** Product lookup by exact barcode — the hot path used when a scanner fires. */
export async function findProductByBarcode(companyId: string, barcode: string, branchId: string) {
  const match = await prisma.productBarcode.findUnique({
    where: { barcode },
    include: {
      product: {
        include: { inventory: { where: { branchId } } },
      },
    },
  });
  if (!match || match.product.companyId !== companyId || !match.product.isActive) return null;
  return match.product;
}