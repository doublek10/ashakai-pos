'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { signOut } from '@/lib/auth/logout-client';

type TrackingType = 'PIECE' | 'WEIGHT';

interface Product {
  id: string;
  name: string;
  sku: string;
  sellingPrice: string;
  costPrice: string;
  reorderLevel: string | number;
  unit: string;
  trackingType: TrackingType;
  weightUnit: string | null;
  inventory: { quantity: string | number }[];
}

const emptyForm = {
  name: '',
  sku: '',
  costPrice: '',
  sellingPrice: '',
  reorderLevel: '10',
  trackingType: 'PIECE' as TrackingType,
  weightUnit: 'kg' as 'kg' | 'g',
};

export default function ProductsClient() {
  const [products, setProducts] = useState<Product[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const data = await apiFetch<{ products: Product[] }>('/api/products');
    setProducts(data.products);
  }

  useEffect(() => {
    load();
  }, []);

  async function createProduct(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const isWeight = form.trackingType === 'WEIGHT';
      await apiFetch('/api/products', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          sku: form.sku,
          costPrice: Number(form.costPrice),
          sellingPrice: Number(form.sellingPrice),
          reorderLevel: Number(form.reorderLevel),
          trackingType: form.trackingType,
          weightUnit: isWeight ? form.weightUnit : undefined,
          unit: isWeight ? form.weightUnit : 'pcs',
        }),
      });
      setForm(emptyForm);
      setShowForm(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create product');
    }
  }

  return (
    <div className="min-h-screen bg-paper">
      <header className="flex items-center justify-between px-8 py-5 bg-white border-b border-black/5">
        <div>
          <p className="text-xs text-ink/40 uppercase tracking-wide">Product management</p>
          <h1 className="text-lg font-semibold">Products</h1>
        </div>
        <nav className="flex items-center gap-5 text-sm">
          <a href="/dashboard" className="text-ink/60 hover:text-ink">Dashboard</a>
          <a href="/pos" className="text-ink/60 hover:text-ink">POS</a>
          <button
            onClick={() => setShowForm((s) => !s)}
            className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium px-4 py-2"
          >
            + Add product
          </button>
          <button onClick={signOut} className="text-ink/60 hover:text-ink">Sign out</button>
        </nav>
      </header>

      <main className="p-8 max-w-5xl mx-auto">
        {showForm && (
          <form onSubmit={createProduct} className="bg-white rounded-xl border border-black/5 p-5 mb-6 space-y-3">
            <div className="grid grid-cols-5 gap-3 items-end">
              <Field label="Name"><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input" /></Field>
              <Field label="SKU"><input required value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} className="input" /></Field>
              <Field label="Cost price"><input required type="number" step="0.01" value={form.costPrice} onChange={(e) => setForm({ ...form, costPrice: e.target.value })} className="input" /></Field>
              <Field label="Selling price"><input required type="number" step="0.01" value={form.sellingPrice} onChange={(e) => setForm({ ...form, sellingPrice: e.target.value })} className="input" /></Field>
              <Field label="Sold by">
                <select
                  value={form.trackingType}
                  onChange={(e) => setForm({ ...form, trackingType: e.target.value as TrackingType })}
                  className="input"
                >
                  <option value="PIECE">Piece / unit</option>
                  <option value="WEIGHT">Weight (loose)</option>
                </select>
              </Field>
            </div>

            {form.trackingType === 'WEIGHT' ? (
              <div className="grid grid-cols-5 gap-3 items-end">
                <Field label="Weight unit">
                  <select
                    value={form.weightUnit}
                    onChange={(e) => setForm({ ...form, weightUnit: e.target.value as 'kg' | 'g' })}
                    className="input"
                  >
                    <option value="kg">Kilograms (kg)</option>
                    <option value="g">Grams (g)</option>
                  </select>
                </Field>
                <Field label={`Low-stock alert (${form.weightUnit})`}>
                  <input required type="number" step="0.001" value={form.reorderLevel} onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })} className="input" />
                </Field>
                <p className="col-span-3 text-xs text-ink/40 pb-2">
                  Price and cost above are per {form.weightUnit}. Stock and sale quantities for this product are entered
                  as weight (e.g. 1.250 {form.weightUnit}) — from the till's keypad or a connected weighing scale.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-5 gap-3 items-end">
                <Field label="Low-stock alert (units)">
                  <input required type="number" step="1" value={form.reorderLevel} onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })} className="input" />
                </Field>
              </div>
            )}

            <div className="flex items-center gap-3">
              <button type="submit" className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium px-4 py-2.5">Save</button>
              {error && <p className="text-sm text-danger">{error}</p>}
            </div>
          </form>
        )}

        <div className="bg-white rounded-xl border border-black/5 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-ink/40 text-xs uppercase bg-black/[0.02]">
                <th className="px-4 py-3 font-medium">Product</th>
                <th className="px-4 py-3 font-medium">SKU</th>
                <th className="px-4 py-3 font-medium">Sold by</th>
                <th className="px-4 py-3 font-medium text-right">Stock</th>
                <th className="px-4 py-3 font-medium text-right">Cost</th>
                <th className="px-4 py-3 font-medium text-right">Price</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => {
                const isWeight = p.trackingType === 'WEIGHT';
                const stock = p.inventory.reduce((s, i) => s + Number(i.quantity), 0);
                const low = stock <= Number(p.reorderLevel);
                const unitLabel = isWeight ? p.weightUnit ?? 'kg' : p.unit || 'pcs';
                return (
                  <tr key={p.id} className="border-t border-black/5">
                    <td className="px-4 py-3">{p.name}</td>
                    <td className="px-4 py-3 text-ink/50">{p.sku}</td>
                    <td className="px-4 py-3 text-ink/50">
                      {isWeight ? (
                        <span className="inline-flex items-center rounded-full bg-brand-50 text-brand-700 px-2 py-0.5 text-xs font-medium">
                          By weight ({unitLabel})
                        </span>
                      ) : (
                        <span className="text-ink/40">Piece</span>
                      )}
                    </td>
                    <td className={`px-4 py-3 text-right font-medium ${low ? 'text-warn' : ''}`}>
                      {isWeight ? stock.toFixed(3) : stock} {unitLabel}
                      {low && <span className="block text-[10px] font-normal text-warn/80">Low stock</span>}
                    </td>
                    <td className="px-4 py-3 text-right text-ink/50">
                      KES {Number(p.costPrice).toFixed(2)}{isWeight ? ` /${unitLabel}` : ''}
                    </td>
                    <td className="px-4 py-3 text-right">
                      KES {Number(p.sellingPrice).toFixed(2)}{isWeight ? ` /${unitLabel}` : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-ink/50 mb-1">{label}</span>
      {children}
    </label>
  );
}
