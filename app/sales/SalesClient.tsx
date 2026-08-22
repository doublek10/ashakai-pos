'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { signOut } from '@/lib/auth/logout-client';

interface SaleItemRow {
  productId: string;
  productName: string;
  sku: string;
  quantity: number;
  weightUnit: string | null;
  lineTotal: number;
}

interface SaleRow {
  id: string;
  createdAt: string;
  total: number;
  status: string;
  cashierName: string;
  paymentMethod: string | null;
  paymentReference: string | null;
  receiptNumber: string | null;
  items: SaleItemRow[];
}

interface SaleGroup {
  date: string;
  isToday: boolean;
  label: string;
  total: number;
  count: number;
  sales: SaleRow[];
}

interface OwnerReportResponse {
  todayDate: string;
  timezone: string;
  groups: SaleGroup[];
}

type MethodFilter = 'ALL' | 'CASH' | 'MPESA';

export default function SalesClient({ ownerName }: { ownerName: string }) {
  const [methodFilter, setMethodFilter] = useState<MethodFilter>('ALL');
  const [dateSearch, setDateSearch] = useState(''); // "YYYY-MM-DD"
  const [groups, setGroups] = useState<SaleGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (methodFilter !== 'ALL') params.set('method', methodFilter);
    if (dateSearch) params.set('date', dateSearch);

    apiFetch<OwnerReportResponse>(`/api/sales/owner-report?${params.toString()}`)
      .then((data) => {
        if (!cancelled) setGroups(data.groups);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load sales');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [methodFilter, dateSearch]);

  // All metrics below are derived from exactly the sales currently
  // loaded (i.e. respecting the method/date filters above) — so
  // "POS metrics" always describes whatever the owner is looking at,
  // not always all-time totals.
  const metrics = useMemo(() => buildMetrics(groups), [groups]);

  return (
    <div className="min-h-screen bg-paper">
      <header className="flex items-center justify-between px-8 py-5 bg-white border-b border-black/5">
        <div>
          <p className="text-xs text-ink/40 uppercase tracking-wide">Sales log</p>
          <h1 className="text-lg font-semibold">Welcome back, {ownerName}</h1>
        </div>
        <nav className="flex gap-5 text-sm">
          <a href="/dashboard" className="text-ink/60 hover:text-ink">Dashboard</a>
          <a href="/products" className="text-ink/60 hover:text-ink">Products</a>
          <a href="/employees" className="text-ink/60 hover:text-ink">Employees</a>
          <a href="/pos" className="text-ink/60 hover:text-ink">POS</a>
          <button onClick={signOut} className="text-ink/60 hover:text-ink">Sign out</button>
        </nav>
      </header>

      <main className="p-8 max-w-6xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2">
            {(['ALL', 'CASH', 'MPESA'] as MethodFilter[]).map((m) => (
              <button
                key={m}
                onClick={() => setMethodFilter(m)}
                className={`rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors ${
                  methodFilter === m ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-black/10 hover:bg-black/5'
                }`}
              >
                {m === 'ALL' ? 'All' : m === 'MPESA' ? 'M-Pesa only' : 'Cash only'}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs text-ink/50">Search by date</label>
            <input
              type="date"
              value={dateSearch}
              onChange={(e) => setDateSearch(e.target.value)}
              className="rounded-lg border border-black/10 px-3 py-2 text-sm"
            />
            {dateSearch && (
              <button onClick={() => setDateSearch('')} className="text-xs text-ink/50 hover:text-ink">
                Clear
              </button>
            )}
          </div>
        </div>

        {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

        {!loading && !error && groups.length > 0 && <MetricsPanel metrics={metrics} />}

        {loading ? (
          <p className="text-sm text-ink/40">Loading sales…</p>
        ) : groups.length === 0 ? (
          <p className="text-sm text-ink/40">No sales found for this filter.</p>
        ) : (
          <div className="space-y-6">
            {groups.map((group) => (
              <SalesDayGroup key={group.date} group={group} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

// ------------------------------------------------------------------
// Metrics: aggregated purely client-side from the sales already
// fetched for the current filter — no extra API call needed, since
// the owner-report response already carries every line item.
// ------------------------------------------------------------------

interface ProductStat {
  productName: string;
  unitsSold: number;
  weightUnit: string | null; // set when this product is sold by weight, so units can be labelled "kg" instead of a bare count
  revenue: number;
  timesSold: number;
}

interface Metrics {
  totalRevenue: number;
  saleCount: number;
  averageSale: number;
  byPaymentMethod: { method: string; total: number; count: number }[];
  topByRevenue: ProductStat[];
  topByUnits: ProductStat[];
}

function buildMetrics(groups: SaleGroup[]): Metrics {
  const allSales = groups.flatMap((g) => g.sales);
  const totalRevenue = allSales.reduce((sum, s) => sum + s.total, 0);
  const saleCount = allSales.length;
  const averageSale = saleCount > 0 ? totalRevenue / saleCount : 0;

  const methodTotals = new Map<string, { total: number; count: number }>();
  for (const sale of allSales) {
    const key = sale.paymentMethod ?? 'UNKNOWN';
    const entry = methodTotals.get(key) ?? { total: 0, count: 0 };
    entry.total += sale.total;
    entry.count += 1;
    methodTotals.set(key, entry);
  }
  const byPaymentMethod = Array.from(methodTotals.entries())
    .map(([method, v]) => ({ method, ...v }))
    .sort((a, b) => b.total - a.total);

  // Aggregate every line item across every sale, by product name — this
  // is what makes the panel useful for stock analysis: which products
  // are actually moving, by both revenue and quantity.
  const productTotals = new Map<string, ProductStat>();
  for (const sale of allSales) {
    for (const item of sale.items) {
      const entry = productTotals.get(item.productName) ?? {
        productName: item.productName,
        unitsSold: 0,
        weightUnit: item.weightUnit,
        revenue: 0,
        timesSold: 0,
      };
      entry.unitsSold += item.quantity;
      entry.revenue += item.lineTotal;
      entry.timesSold += 1;
      productTotals.set(item.productName, entry);
    }
  }
  const products = Array.from(productTotals.values());
  const topByRevenue = [...products].sort((a, b) => b.revenue - a.revenue).slice(0, 5);
  const topByUnits = [...products].sort((a, b) => b.unitsSold - a.unitsSold).slice(0, 5);

  return { totalRevenue, saleCount, averageSale, byPaymentMethod, topByRevenue, topByUnits };
}

function MetricsPanel({ metrics }: { metrics: Metrics }) {
  return (
    <div className="bg-white rounded-xl border border-black/5 p-5 space-y-5">
      <div>
        <p className="text-xs font-medium text-ink/40 uppercase tracking-wide mb-3">POS metrics · this filter</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Total revenue" value={`KES ${metrics.totalRevenue.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
          <StatCard label="Sales count" value={metrics.saleCount.toLocaleString()} />
          <StatCard label="Average sale" value={`KES ${metrics.averageSale.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
          <StatCard
            label="Top payment method"
            value={metrics.byPaymentMethod[0] ? formatMethod(metrics.byPaymentMethod[0].method) : '—'}
          />
        </div>
      </div>

      <div className="grid sm:grid-cols-3 gap-5">
        <div>
          <p className="text-xs font-medium text-ink/40 uppercase tracking-wide mb-2">By payment method</p>
          {metrics.byPaymentMethod.length === 0 ? (
            <p className="text-xs text-ink/40">No sales yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {metrics.byPaymentMethod.map((m) => (
                <li key={m.method} className="flex justify-between text-sm">
                  <span className="text-ink/60">{formatMethod(m.method)} · {m.count}</span>
                  <span className="font-medium">KES {m.total.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <p className="text-xs font-medium text-ink/40 uppercase tracking-wide mb-2">Top products · by revenue</p>
          {metrics.topByRevenue.length === 0 ? (
            <p className="text-xs text-ink/40">No items sold yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {metrics.topByRevenue.map((p) => (
                <li key={p.productName} className="flex justify-between text-sm">
                  <span className="text-ink/60 truncate pr-2">{p.productName}</span>
                  <span className="font-medium whitespace-nowrap">KES {p.revenue.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <p className="text-xs font-medium text-ink/40 uppercase tracking-wide mb-2">Top products · by quantity</p>
          {metrics.topByUnits.length === 0 ? (
            <p className="text-xs text-ink/40">No items sold yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {metrics.topByUnits.map((p) => (
                <li key={p.productName} className="flex justify-between text-sm">
                  <span className="text-ink/60 truncate pr-2">{p.productName}</span>
                  <span className="font-medium whitespace-nowrap">
                    {p.unitsSold.toLocaleString(undefined, { maximumFractionDigits: 3 })}
                    {p.weightUnit ? ` ${p.weightUnit}` : ' pcs'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-paper border border-black/5 px-3.5 py-3">
      <p className="text-[11px] text-ink/40 uppercase tracking-wide">{label}</p>
      <p className="text-base font-semibold mt-0.5">{value}</p>
    </div>
  );
}

function formatMethod(method: string) {
  return method === 'MPESA' ? 'M-Pesa' : method.replaceAll('_', ' ');
}

// ------------------------------------------------------------------
// Per-day table (existing behaviour, now with a Products column).
// ------------------------------------------------------------------

function SalesDayGroup({ group }: { group: SaleGroup }) {
  return (
    <div className={`bg-white rounded-xl border p-5 ${group.isToday ? 'border-brand-300 ring-1 ring-brand-100' : 'border-black/5'}`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold">{group.label}</p>
          {group.isToday && (
            <span className="text-[10px] uppercase tracking-wide font-medium text-brand-700 bg-brand-50 border border-brand-200 rounded-full px-2 py-0.5">
              Today
            </span>
          )}
        </div>
        <div className="text-sm text-ink/50">
          {group.count} sale{group.count === 1 ? '' : 's'} · <span className="font-medium text-ink">KES {group.total.toLocaleString()}</span>
        </div>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-ink/40 text-xs uppercase">
            <th className="pb-2 font-medium">Time</th>
            <th className="pb-2 font-medium">Receipt</th>
            <th className="pb-2 font-medium">Products</th>
            <th className="pb-2 font-medium">Cashier</th>
            <th className="pb-2 font-medium">Method</th>
            <th className="pb-2 font-medium text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {group.sales.map((sale) => (
            <tr key={sale.id} className="border-t border-black/5">
              <td className="py-2 text-ink/60 align-top whitespace-nowrap">
                {new Date(sale.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </td>
              <td className="py-2 text-ink/60 align-top whitespace-nowrap">{sale.receiptNumber ?? '—'}</td>
              <td className="py-2 align-top max-w-xs">
                <ProductsCell items={sale.items} />
              </td>
              <td className="py-2 align-top whitespace-nowrap">{sale.cashierName}</td>
              <td className="py-2 align-top whitespace-nowrap">
                <PaymentBadge method={sale.paymentMethod} />
              </td>
              <td className="py-2 text-right font-medium align-top whitespace-nowrap">KES {sale.total.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Renders a sale's line items as "Name (qty unit)" chips, e.g. "Rice (0.5kg), Sugar (3)". */
function ProductsCell({ items }: { items: SaleItemRow[] }) {
  if (!items || items.length === 0) {
    return <span className="text-xs text-ink/40">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item, i) => (
        <span
          key={`${item.productId}-${i}`}
          title={`${item.productName} · KES ${item.lineTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
          className="text-xs bg-black/5 text-ink/70 rounded-full px-2 py-0.5 whitespace-nowrap"
        >
          {item.productName}
          <span className="text-ink/40">
            {' '}
            ({item.quantity.toLocaleString(undefined, { maximumFractionDigits: 3 })}
            {item.weightUnit ?? ''})
          </span>
        </span>
      ))}
    </div>
  );
}

function PaymentBadge({ method }: { method: string | null }) {
  if (!method) {
    return <span className="text-xs text-ink/40">—</span>;
  }
  const isCash = method === 'CASH';
  const isMpesa = method === 'MPESA';
  return (
    <span
      className={`text-[11px] font-medium uppercase tracking-wide rounded-full px-2 py-0.5 border ${
        isCash
          ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
          : isMpesa
            ? 'text-green-700 bg-green-50 border-green-200'
            : 'text-ink/60 bg-black/5 border-black/10'
      }`}
    >
      {formatMethod(method)}
    </span>
  );
}