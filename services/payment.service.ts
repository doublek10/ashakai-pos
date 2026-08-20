import { prisma } from '@/lib/database/client';
import { recordAudit } from '@/lib/audit';
import { ApiError } from '@/lib/permissions/guard';

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
