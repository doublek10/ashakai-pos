'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { signOut } from '@/lib/auth/logout-client';
import ReceiptPrint, { fetchReceiptData } from '@/components/receipts/ReceiptPrint';
import { ReceiptData } from '@/lib/receipts/escpos';
import { useScale } from '@/lib/scale/scale-client';
import { MpesaCaptureButton } from '@/components/pos/MpesaCaptureButton';

type TrackingType = 'PIECE' | 'WEIGHT';

interface Product {
  id: string;
  name: string;
  sku: string;
  sellingPrice: string;
  taxRate: string;
  trackingType: TrackingType;
  weightUnit: string | null;
  barcodes: { barcode: string }[];
  inventory: { quantity: string | number }[];
}

interface CartLine {
  product: Product;
  quantity: number;
}

type PayMethod = 'CASH' | 'MPESA' | 'PESAPAL' | 'CARD';

/** Convert a scale reading into the product's own weightUnit (kg/g), so a scale set to grams still works against a product priced per kg. */
function convertToProductUnit(value: number, from: 'kg' | 'g', to: 'kg' | 'g') {
  if (from === to) return value;
  return from === 'g' && to === 'kg' ? value / 1000 : value * 1000;
}

export default function PosScreen({
  cashierName,
  branchId,
  role,
}: {
  cashierName: string;
  branchId: string;
  role: string;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [payMethod, setPayMethod] = useState<PayMethod | null>(null);
  const [phone, setPhone] = useState('');
  const [cashGiven, setCashGiven] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [receiptData, setReceiptData] = useState<ReceiptData | null>(null);

  // Password-confirmation gate for removing a line from the cart —
  // any cashier/product manager/owner can remove a scanned item, but
  // only after re-entering their own login password.
  const [removeTarget, setRemoveTarget] = useState<{ productId: string; name: string } | null>(null);
  const [removePassword, setRemovePassword] = useState('');
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Optional weighing-scale connection. If no scale-bridge is running
  // (see /scale-bridge in the repo), `connected` just stays false and
  // cashiers type weights in manually — nothing else changes.
  const scale = useScale();

  // The scan-as-keyboard-input pattern from spec section 14: a barcode
  // scanner types digits fast then hits Enter. We just search-on-submit;
  // no special hardware API is needed for USB HID scanners.
  useEffect(() => {
    searchRef.current?.focus();
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  async function runSearch(term: string) {
    if (!term.trim()) {
      setResults([]);
      return;
    }
    const data = await apiFetch<{ products: Product[] }>(
      `/api/products?search=${encodeURIComponent(term)}&branchId=${branchId}`
    );
    setResults(data.products);
  }

  function addToCart(product: Product) {
    setCart((prev) => {
      const existing = prev.find((l) => l.product.id === product.id);
      if (existing) {
        // For weight products, scanning/searching the same item again
        // is almost always "weigh a second portion", not "+1 piece" —
        // just leave the existing line for the cashier to re-weigh.
        if (product.trackingType === 'WEIGHT') return prev;
        return prev.map((l) => (l.product.id === product.id ? { ...l, quantity: l.quantity + 1 } : l));
      }
      const initialQty =
        product.trackingType === 'WEIGHT'
          ? scale.connected && scale.reading
            ? convertToProductUnit(scale.reading.weight, scale.reading.unit, (product.weightUnit as 'kg' | 'g') ?? 'kg')
            : 0
          : 1;
      return [...prev, { product, quantity: initialQty }];
    });
    setQuery('');
    setResults([]);
    searchRef.current?.focus();
  }

  function updateQty(productId: string, quantity: number) {
    if (quantity <= 0) {
      setCart((prev) => prev.filter((l) => l.product.id !== productId));
      return;
    }
    setCart((prev) => prev.map((l) => (l.product.id === productId ? { ...l, quantity } : l)));
  }

  /** Pulls the current live scale reading into a weight-tracked cart line. */
  function captureWeight(productId: string, weightUnit: string | null) {
    if (!scale.reading) return;
    const qty = convertToProductUnit(scale.reading.weight, scale.reading.unit, (weightUnit as 'kg' | 'g') ?? 'kg');
    updateQty(productId, qty);
  }

  /** Opens the "confirm your password" modal for a given cart line. */
  function askRemove(productId: string, name: string) {
    setRemoveTarget({ productId, name });
    setRemovePassword('');
    setRemoveError(null);
  }

  function closeRemoveModal() {
    if (removeBusy) return; // don't let it be dismissed mid-check
    setRemoveTarget(null);
    setRemovePassword('');
    setRemoveError(null);
  }

  /** Re-checks the logged-in user's own password, then removes the line. */
  async function confirmRemove() {
    if (!removeTarget) return;
    if (!removePassword) {
      setRemoveError('Enter your password');
      return;
    }
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await apiFetch('/api/auth/verify-password', {
        method: 'POST',
        body: JSON.stringify({ password: removePassword }),
      });
      setCart((prev) => prev.filter((l) => l.product.id !== removeTarget.productId));
      setRemoveTarget(null);
      setRemovePassword('');
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : 'Incorrect password');
    } finally {
      setRemoveBusy(false);
    }
  }

  const subtotal = cart.reduce((s, l) => s + Number(l.product.sellingPrice) * l.quantity, 0);
  const tax = cart.reduce(
    (s, l) => s + Number(l.product.sellingPrice) * l.quantity * (Number(l.product.taxRate) / 100),
    0
  );
  const total = subtotal + tax;
  const cashGivenNum = Number(cashGiven) || 0;
  const change = cashGivenNum - total;

  // A weight-tracked line with 0 (or no) weight yet isn't sellable —
  // block checkout until every such line has a real reading, rather
  // than silently ringing up a KES 0.00 line.
  const hasUnweighedLine = cart.some((l) => l.product.trackingType === 'WEIGHT' && l.quantity <= 0);

  function resetCart() {
    setCart([]);
    setPayMethod(null);
    setCashGiven('');
    setPhone('');
  }

  /**
   * Polls the sale until its digital payment webhook has completed it
   * (or it's been long enough that we give up and tell the cashier to
   * check the sales log — the webhook may still land later). This is a
   * UI convenience only; the sale is genuinely completed server-side by
   * the webhook handler regardless of whether this tab is still open.
   */
  function pollForCompletion(saleId: string) {
    let attempts = 0;
    pollTimer.current = setInterval(async () => {
      attempts += 1;
      try {
        const data = await apiFetch<{ sale: any }>(`/api/sales/${saleId}`);
        if (data.sale.status === 'COMPLETED') {
          if (pollTimer.current) clearInterval(pollTimer.current);
          const receipt = await fetchReceiptData(saleId);
          setReceiptData(receipt);
          setMessage(null);
          resetCart();
        } else if (attempts > 40) {
          // ~2 minutes at 3s intervals
          if (pollTimer.current) clearInterval(pollTimer.current);
          setMessage('Still waiting on payment confirmation. Check Sales once the customer confirms.');
        }
      } catch {
        // transient network hiccup — keep polling
      }
    }, 3000);
  }

  async function completeSale() {
    if (cart.length === 0 || !payMethod || hasUnweighedLine) return;
    setBusy(true);
    setMessage(null);
    try {
      const items = cart.map((l) => ({ productId: l.product.id, quantity: l.quantity }));

      if (payMethod === 'CASH') {
        const data = await apiFetch<{ sale: { id: string } }>('/api/sales', {
          method: 'POST',
          body: JSON.stringify({
            branchId,
            items,
            cashPayments: [{ method: 'CASH', amount: total }],
          }),
        });
        const receipt = await fetchReceiptData(data.sale.id);
        setReceiptData(receipt);
        setMessage(`Change due: KES ${Math.max(change, 0).toFixed(2)}`);
        resetCart();
      } else if (payMethod === 'MPESA') {
        const data = await apiFetch<{ saleId: string; merchantReference: string }>('/api/payments/mpesa', {
          method: 'POST',
          body: JSON.stringify({ branchId, items, phone }),
        });
        setMessage(`STK push sent to ${phone}. Waiting for customer to enter M-Pesa PIN…`);
        pollForCompletion(data.saleId);
      } else if (payMethod === 'PESAPAL') {
        const data = await apiFetch<{ saleId: string; redirectUrl?: string }>('/api/payments/pesapal', {
          method: 'POST',
          body: JSON.stringify({ branchId, items }),
        });
        if (data.redirectUrl) window.open(data.redirectUrl, '_blank');
        setMessage('Redirecting customer to PesaPal to complete payment…');
        pollForCompletion(data.saleId);
      } else if (payMethod === 'CARD') {
        const data = await apiFetch<{ saleId: string; redirectUrl?: string }>('/api/payments/cards', {
          method: 'POST',
          body: JSON.stringify({ branchId, items, email: 'walkin@customer.local' }),
        });
        if (data.redirectUrl) window.open(data.redirectUrl, '_blank');
        setMessage('Redirecting customer to complete card payment…');
        pollForCompletion(data.saleId);
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Sale failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-screen flex flex-col bg-paper">
      <header className="flex items-center justify-between px-5 py-3 bg-white border-b border-black/5">
        <div className="flex items-center gap-4">
          <div>
            <p className="text-xs text-ink/50">Cashier</p>
            <p className="font-medium text-sm">{cashierName}</p>
          </div>
          <span
            title={scale.connected ? 'Weighing scale connected' : 'No weighing scale connected — enter weights manually'}
            className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border ${
              scale.connected ? 'border-brand-200 bg-brand-50 text-brand-700' : 'border-black/10 text-ink/40'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${scale.connected ? 'bg-brand-500' : 'bg-ink/20'}`} />
            {scale.connected ? 'Scale connected' : 'No scale'}
          </span>
          <MpesaCaptureButton />
        </div>
        <form
          className="flex-1 max-w-xl mx-6 relative"
          onSubmit={(e) => {
            e.preventDefault();
            runSearch(query);
          }}
        >
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              runSearch(e.target.value);
            }}
            placeholder="Scan barcode or search products…"
            className="w-full rounded-lg border border-black/10 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          {results.length > 0 && (
            <div className="absolute mt-1 w-full bg-white rounded-lg shadow-lg border border-black/10 z-10 overflow-hidden">
              {results.slice(0, 8).map((p) => (
                <button
                  key={p.id}
                  onClick={() => addToCart(p)}
                  className="w-full text-left px-4 py-2.5 text-sm hover:bg-brand-50 flex justify-between"
                >
                  <span>
                    {p.name} <span className="text-ink/40">· {p.sku}</span>
                    {p.trackingType === 'WEIGHT' && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide text-brand-600">by weight</span>
                    )}
                  </span>
                  <span className="font-medium">
                    KES {Number(p.sellingPrice).toFixed(2)}
                    {p.trackingType === 'WEIGHT' ? ` /${p.weightUnit ?? 'kg'}` : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
        </form>
        <button onClick={signOut} className="text-sm text-ink/50 hover:text-ink">Sign out</button>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <section className="flex-1 overflow-y-auto p-5">
          <p className="text-xs font-medium text-ink/40 uppercase tracking-wide mb-3">Cart</p>
          {cart.length === 0 ? (
            <p className="text-sm text-ink/40 mt-8 text-center">Scan or search a product to begin.</p>
          ) : (
            <div className="space-y-2">
              {cart.map((line) => {
                const isWeight = line.product.trackingType === 'WEIGHT';
                const unit = line.product.weightUnit ?? 'kg';
                return (
                  <div key={line.product.id} className="flex items-center justify-between bg-white rounded-lg border border-black/5 px-4 py-3">
                    <div>
                      <p className="text-sm font-medium">{line.product.name}</p>
                      <p className="text-xs text-ink/40">
                        KES {Number(line.product.sellingPrice).toFixed(2)} {isWeight ? `per ${unit}` : 'each'}
                      </p>
                    </div>

                    {isWeight ? (
                      <div className="flex items-center gap-2">
                        {scale.connected && (
                          <button
                            onClick={() => captureWeight(line.product.id, line.product.weightUnit)}
                            disabled={!scale.reading}
                            title={
                              scale.reading
                                ? `Use live reading: ${scale.reading.weight} ${scale.reading.unit}${scale.reading.stable ? '' : ' (settling…)'}`
                                : 'Waiting for a reading…'
                            }
                            className="text-xs font-medium rounded-md border border-brand-200 bg-brand-50 text-brand-700 px-2 py-1.5 disabled:opacity-40"
                          >
                            {scale.reading
                              ? `Use scale · ${scale.reading.weight}${scale.reading.unit}${scale.reading.stable ? '' : '…'}`
                              : 'Use scale'}
                          </button>
                        )}
                        <input
                          type="number"
                          step="0.001"
                          min="0"
                          value={line.quantity || ''}
                          onChange={(e) => updateQty(line.product.id, Number(e.target.value))}
                          placeholder={`0.000`}
                          className={`w-24 rounded-md border px-2 py-1.5 text-sm text-right ${
                            line.quantity <= 0 ? 'border-warn/50 bg-warn/5' : 'border-black/10'
                          }`}
                        />
                        <span className="text-xs text-ink/40 w-6">{unit}</span>
                        <span className="w-20 text-right text-sm font-medium">
                          KES {(Number(line.product.sellingPrice) * line.quantity).toFixed(2)}
                        </span>
                        <button
                          onClick={() => askRemove(line.product.id, line.product.name)}
                          title="Remove from cart"
                          className="text-xs font-medium text-red-600 hover:text-red-700 px-1.5"
                        >
                          Remove
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <button onClick={() => updateQty(line.product.id, line.quantity - 1)} className="h-7 w-7 rounded-full border border-black/10 text-sm">–</button>
                        <span className="w-6 text-center text-sm">{line.quantity}</span>
                        <button onClick={() => updateQty(line.product.id, line.quantity + 1)} className="h-7 w-7 rounded-full border border-black/10 text-sm">+</button>
                        <span className="w-20 text-right text-sm font-medium">
                          KES {(Number(line.product.sellingPrice) * line.quantity).toFixed(2)}
                        </span>
                        <button
                          onClick={() => askRemove(line.product.id, line.product.name)}
                          title="Remove from cart"
                          className="text-xs font-medium text-red-600 hover:text-red-700 px-1.5"
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              {hasUnweighedLine && (
                <p className="text-xs text-warn px-1">Enter or capture a weight for every loose item before checking out.</p>
              )}
            </div>
          )}
        </section>

        <aside className="w-96 bg-white border-l border-black/5 flex flex-col">
          <div className="p-5 space-y-1.5 border-b border-black/5">
            <Row label="Subtotal" value={subtotal} />
            <Row label="Tax" value={tax} />
            <Row label="Total" value={total} bold />
          </div>

          <div className="p-5 space-y-3 flex-1 overflow-y-auto">
            <p className="text-xs font-medium text-ink/40 uppercase tracking-wide">Payment method</p>
            <div className="grid grid-cols-2 gap-2">
              {(['CASH', 'MPESA', 'PESAPAL', 'CARD'] as PayMethod[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setPayMethod(m)}
                  className={`rounded-lg border py-2.5 text-sm font-medium transition-colors ${
                    payMethod === m ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-black/10 hover:bg-black/5'
                  }`}
                >
                  {m === 'MPESA' ? 'M-Pesa' : m === 'PESAPAL' ? 'PesaPal' : m[0] + m.slice(1).toLowerCase()}
                </button>
              ))}
            </div>

            {payMethod === 'CASH' && (
              <div>
                <label className="block text-xs text-ink/50 mb-1">Cash given</label>
                <input
                  type="number"
                  value={cashGiven}
                  onChange={(e) => setCashGiven(e.target.value)}
                  className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
                  placeholder={total.toFixed(2)}
                />
                {cashGivenNum > 0 && (
                  <p className="text-xs text-ink/50 mt-1">Change: KES {Math.max(change, 0).toFixed(2)}</p>
                )}
              </div>
            )}
            {payMethod === 'MPESA' && (
              <div>
                <label className="block text-xs text-ink/50 mb-1">Customer phone (STK push)</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="2547XXXXXXXX"
                  className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
                />
              </div>
            )}

            {message && (
              <p className="text-sm rounded-lg bg-brand-50 text-brand-700 px-3 py-2">{message}</p>
            )}
          </div>

          <div className="p-5 border-t border-black/5">
            <button
              onClick={completeSale}
              disabled={cart.length === 0 || !payMethod || busy || hasUnweighedLine || (payMethod === 'MPESA' && !phone)}
              className="w-full rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white font-medium py-3 text-sm"
            >
              {busy ? 'Processing…' : `Complete sale · KES ${total.toFixed(2)}`}
            </button>
          </div>
        </aside>
      </div>

      {receiptData && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 no-print">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full max-h-[90vh] overflow-y-auto">
            <ReceiptPrint receipt={receiptData} />
            <button
              onClick={() => setReceiptData(null)}
              className="w-full mt-3 text-sm text-ink/50 hover:text-ink py-2"
            >
              Close · new sale
            </button>
          </div>
        </div>
      )}

      {removeTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full">
            <p className="text-sm font-medium">Remove &quot;{removeTarget.name}&quot; from the cart?</p>
            <p className="text-xs text-ink/50 mt-1">Enter your login password to confirm.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                confirmRemove();
              }}
            >
              <input
                type="password"
                autoFocus
                value={removePassword}
                onChange={(e) => {
                  setRemovePassword(e.target.value);
                  setRemoveError(null);
                }}
                placeholder="Your password"
                className={`w-full mt-4 rounded-lg border px-3 py-2 text-sm ${
                  removeError ? 'border-red-400' : 'border-black/10'
                }`}
              />
              {removeError && <p className="text-xs text-red-600 mt-1.5">{removeError}</p>}

              <div className="flex gap-2 mt-4">
                <button
                  type="button"
                  onClick={closeRemoveModal}
                  disabled={removeBusy}
                  className="flex-1 rounded-lg border border-black/10 py-2 text-sm font-medium hover:bg-black/5 disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={removeBusy || !removePassword}
                  className="flex-1 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white text-sm font-medium py-2"
                >
                  {removeBusy ? 'Checking…' : 'Remove item'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className={`flex justify-between text-sm ${bold ? 'font-semibold text-base pt-1' : 'text-ink/60'}`}>
      <span>{label}</span>
      <span>KES {value.toFixed(2)}</span>
    </div>
  );
}
