'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { signOut } from '@/lib/auth/logout-client';

interface SaleRow {
  id: string;
  createdAt: string;
  total: number;
  status: string;
  cashierName: string;
  paymentMethod: string | null;
  paymentReference: string | null;
  receiptNumber: string | null;
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

      <main className="p-8 max-w-5xl mx-auto space-y-6">
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
            <th className="pb-2 font-medium">Cashier</th>
            <th className="pb-2 font-medium">Method</th>
            <th className="pb-2 font-medium text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {group.sales.map((sale) => (
            <tr key={sale.id} className="border-t border-black/5">
              <td className="py-2 text-ink/60">
                {new Date(sale.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </td>
              <td className="py-2 text-ink/60">{sale.receiptNumber ?? '—'}</td>
              <td className="py-2">{sale.cashierName}</td>
              <td className="py-2">
                <PaymentBadge method={sale.paymentMethod} />
              </td>
              <td className="py-2 text-right font-medium">KES {sale.total.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
      {method === 'MPESA' ? 'M-Pesa' : method.replaceAll('_', ' ')}
    </span>
  );
}
