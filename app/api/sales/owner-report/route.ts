import { NextRequest, NextResponse } from 'next/server';
import { requirePermission, handleApiError } from '@/lib/permissions/guard';
import { prisma } from '@/lib/database/client';

/**
 * GET /api/sales/owner-report?method=&date=&branchId=
 *
 * Powers the owner-only "Sales" page (app/sales/SalesClient.tsx):
 * every COMPLETED sale, grouped by calendar day (today first), each
 * with its line items (product name, quantity, unit) so the owner can
 * see what was actually sold — not just the total — for stock
 * analysis, plus enough data for the on-page metrics panel.
 *
 * Mirrors gateway/sales/owner_report.php exactly (same params, same
 * response shape) so the page behaves identically whether the app is
 * running in direct/Prisma mode or NEXT_PUBLIC_BACKEND_MODE=gateway.
 *
 * "Today" is computed in the COMPANY'S OWN timezone
 * (companies.timezone, e.g. "Africa/Nairobi"), not the server's, so a
 * day always runs 00:00–23:59 local time regardless of where the
 * Next.js server itself is hosted.
 */

const VALID_METHODS = ['CASH', 'MPESA', 'VISA', 'MASTERCARD', 'DEBIT_CARD', 'PESAPAL', 'BANK_TRANSFER'];

/** "YYYY-MM-DD" for a given instant, in a given IANA timezone. */
function localDateKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export async function GET(req: NextRequest) {
  try {
    const session = await requirePermission('reports.view');

    const method = (req.nextUrl.searchParams.get('method') || 'ALL').toUpperCase();
    const dateFilter = (req.nextUrl.searchParams.get('date') || '').trim();
    const branchId = (req.nextUrl.searchParams.get('branchId') || '').trim();

    if (method !== 'ALL' && !VALID_METHODS.includes(method)) {
      return NextResponse.json({ error: 'Unknown payment method filter' }, { status: 400 });
    }
    if (dateFilter && !/^\d{4}-\d{2}-\d{2}$/.test(dateFilter)) {
      return NextResponse.json({ error: 'date must be in YYYY-MM-DD format' }, { status: 400 });
    }

    const company = await prisma.company.findUnique({
      where: { id: session.companyId },
      select: { timezone: true },
    });
    const timezone = company?.timezone || 'Africa/Nairobi';

    const sales = await prisma.sale.findMany({
      where: {
        companyId: session.companyId,
        status: 'COMPLETED',
        ...(branchId ? { branchId } : {}),
        ...(method !== 'ALL' ? { receipt: { paymentMethod: method as any } } : {}),
      },
      include: {
        cashier: { select: { name: true } },
        receipt: true,
        items: {
          select: { productId: true, productName: true, sku: true, quantity: true, weightUnit: true, lineTotal: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 2000,
    });

    const todayDate = localDateKey(new Date(), timezone);

    type Group = {
      date: string;
      isToday: boolean;
      label: string;
      total: number;
      count: number;
      sales: any[];
    };
    const groups: Record<string, Group> = {};

    for (const sale of sales) {
      const day = localDateKey(sale.createdAt, timezone);
      if (dateFilter && day !== dateFilter) continue; // filter in company-local time, same as the PHP gateway

      if (!groups[day]) {
        groups[day] = {
          date: day,
          isToday: day === todayDate,
          label: day === todayDate ? 'Today' : day,
          total: 0,
          count: 0,
          sales: [],
        };
      }

      groups[day].total += Number(sale.total);
      groups[day].count += 1;
      groups[day].sales.push({
        id: sale.id,
        createdAt: sale.createdAt,
        total: Number(sale.total),
        status: sale.status,
        cashierName: sale.cashier.name,
        paymentMethod: sale.receipt?.paymentMethod ?? null,
        paymentReference: sale.receipt?.paymentReference ?? null,
        receiptNumber: sale.receipt?.receiptNumber ?? null,
        items: sale.items.map((i) => ({
          productId: i.productId,
          productName: i.productName,
          sku: i.sku,
          quantity: Number(i.quantity),
          weightUnit: i.weightUnit,
          lineTotal: Number(i.lineTotal),
        })),
      });
    }

    // Keys are "YYYY-MM-DD" strings, so a reverse string sort is also
    // a reverse chronological sort — most recent day first.
    const orderedGroups = Object.values(groups).sort((a, b) => (a.date < b.date ? 1 : -1));

    return NextResponse.json({ todayDate, timezone, groups: orderedGroups });
  } catch (err) {
    return handleApiError(err);
  }
}