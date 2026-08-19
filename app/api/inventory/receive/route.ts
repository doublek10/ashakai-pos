import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission, handleApiError } from '@/lib/permissions/guard';
import { receiveStock } from '@/services/inventory.service';

const schema = z.object({
  supplierId: z.string(),
  branchId: z.string(),
  items: z
    .array(
      z.object({
        productId: z.string(),
        // Not .int(): receiving 25.5kg of loose cereal from a supplier
        // is a valid quantity for a WEIGHT product.
        quantity: z.number().positive(),
        unitCost: z.number().nonnegative(),
      })
    )
    .min(1),
});

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission('inventory.receive');
    const body = schema.parse(await req.json());
    const purchase = await receiveStock({
      companyId: session.companyId,
      actorUserId: session.userId,
      ...body,
    });
    return NextResponse.json({ purchase }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
