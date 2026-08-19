import { NextResponse } from 'next/server';
import { requirePermission, handleApiError } from '@/lib/permissions/guard';
import { prisma } from '@/lib/database/client';

/**
 * Any authenticated user with inventory.view (OWNER, PRODUCT_MANAGER,
 * CASHIER all have it) can fetch the company's branch list. Used by
 * the products page to know which branch to write stock adjustments
 * against — mirrors the same lookup app/pos/page.tsx already does.
 */
export async function GET() {
  try {
    const session = await requirePermission('inventory.view');
    const branches = await prisma.branch.findMany({
      where: { companyId: session.companyId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return NextResponse.json({ branches });
  } catch (err) {
    return handleApiError(err);
  }
}