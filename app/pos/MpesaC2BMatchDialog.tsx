'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';

/**
 * "Customer already paid" M-Pesa flow — for when someone pays your
 * Paybill/Till directly (no STK prompt from this till). Requires
 * gateway/webhooks/mpesa_c2b_confirmation.php to be registered with
 * Daraja (see gateway/scripts/register_c2b_urls.php) — this dialog is
 * only useful in gateway mode (see api-client.ts GATEWAY_ROUTES).
 *
 * Flow:
 *   1. On open, creates a PENDING sale (no STK push) via
 *      /api/payments/mpesa/manual and starts polling.
 *   2. If the C2B listener already auto-matched a payment (there was
 *      exactly one candidate with the right amount), the sale flips to
 *      COMPLETED on its own — we detect that via the sale status and
 *      call onMatched() immediately, same as the STK flow.
 *   3. Otherwise we show any UNMATCHED payments with the right amount
 *      for the cashier to pick from (disambiguating with the M-Pesa
 *      code shown on the customer's confirmation SMS), or they can
 *      type the code directly.
 */

type CartLine = { productId: string; quantity: number; discount?: number };

type Candidate = {
  id: string;
  transId: string;
  transTime: string | null;
  amount: string | number;
  msisdn: string | null;
  firstName: string | null;
  lastName: string | null;
};

export function MpesaC2BMatchDialog({
  open,
  onClose,
  branchId,
  items,
  customerId,
  onMatched,
}: {
  open: boolean;
  onClose: () => void;
  branchId: string;
  items: CartLine[];
  customerId?: string;
  onMatched: (saleId: string) => void;
}) {
  const [phase, setPhase] = useState<'creating' | 'waiting' | 'matching' | 'error'>('creating');
  const [saleId, setSaleId] = useState<string | null>(null);
  const [expectedAmount, setExpectedAmount] = useState<number | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [manualCode, setManualCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!open) return;
    setPhase('creating');
    setError(null);
    setCandidates([]);
    setManualCode('');

    (async () => {
      try {
        const data = await apiFetch<{ saleId: string; amount: number }>('/api/payments/mpesa/manual', {
          method: 'POST',
          body: JSON.stringify({ branchId, items, customerId }),
        });
        setSaleId(data.saleId);
        setExpectedAmount(data.amount);
        setPhase('waiting');
        startPolling(data.saleId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start');
        setPhase('error');
      }
    })();

    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function startPolling(id: string) {
    let attempts = 0;
    pollTimer.current = setInterval(async () => {
      attempts += 1;
      try {
        // Did the C2B listener already auto-match this (only one
        // candidate had the right amount)? If so we're done.
        const saleRes = await apiFetch<{ sale: { status: string } }>(`/api/sales/${id}`);
        if (saleRes.sale.status === 'COMPLETED') {
          if (pollTimer.current) clearInterval(pollTimer.current);
          onMatched(id);
          return;
        }

        const lookup = await apiFetch<{ candidates: Candidate[] }>(
          `/api/payments/mpesa/c2b-lookup?saleId=${encodeURIComponent(id)}`
        );
        setCandidates(lookup.candidates);

        if (attempts > 100) {
          // ~5 minutes at 3s intervals — keep the dialog open (manual
          // code entry still works) but stop hammering the server.
          if (pollTimer.current) clearInterval(pollTimer.current);
        }
      } catch {
        // transient network hiccup — keep polling
      }
    }, 3000);
  }

  async function matchCandidate(c2bPaymentId?: string, transId?: string) {
    if (!saleId) return;
    setPhase('matching');
    setError(null);
    try {
      await apiFetch('/api/payments/mpesa/c2b-match', {
        method: 'POST',
        body: JSON.stringify({ saleId, c2bPaymentId, transId }),
      });
      if (pollTimer.current) clearInterval(pollTimer.current);
      onMatched(saleId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not match that payment');
      setPhase('waiting');
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-base font-semibold mb-1">Customer already paid via M-Pesa</h2>
        <p className="text-sm text-ink/60 mb-4">
          {expectedAmount != null
            ? `Waiting for a confirmed M-Pesa payment of KES ${Number(expectedAmount).toFixed(2)}…`
            : 'Setting up…'}
        </p>

        {phase === 'creating' && <p className="text-sm text-ink/50">Creating sale…</p>}

        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

        {(phase === 'waiting' || phase === 'matching') && (
          <>
            {candidates.length === 0 ? (
              <p className="text-sm text-ink/50 mb-4">
                No matching payment seen yet. This updates automatically once Safaricom confirms it — ask the
                customer to double-check the till number and amount.
              </p>
            ) : (
              <ul className="mb-4 divide-y divide-black/5 border border-black/10 rounded-lg overflow-hidden">
                {candidates.map((c) => (
                  <li key={c.id}>
                    <button
                      disabled={phase === 'matching'}
                      onClick={() => matchCandidate(c.id, undefined)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-brand-50 disabled:opacity-50"
                    >
                      <span className="font-medium">{c.transId}</span>
                      <span className="text-ink/50"> · {c.msisdn ?? 'unknown number'}</span>
                      {(c.firstName || c.lastName) && (
                        <span className="text-ink/50">
                          {' '}
                          · {[c.firstName, c.lastName].filter(Boolean).join(' ')}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <p className="text-xs text-ink/50 mb-1">
              Or ask the customer to read the M-Pesa code from their confirmation SMS and type it here:
            </p>
            <div className="flex gap-2">
              <input
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value.toUpperCase())}
                placeholder="e.g. SFC1234ABC"
                className="flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <button
                disabled={!manualCode || phase === 'matching'}
                onClick={() => matchCandidate(undefined, manualCode)}
                className="px-4 py-2 rounded-lg bg-brand-600 text-white text-sm font-medium disabled:opacity-50"
              >
                Match
              </button>
            </div>
          </>
        )}

        <div className="mt-5 flex justify-end">
          <button onClick={onClose} className="text-sm text-ink/50 hover:text-ink">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
