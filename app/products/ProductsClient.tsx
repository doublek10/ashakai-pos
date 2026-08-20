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
  barcodes: { barcode: string }[];
}

interface Branch {
  id: string;
  name: string;
}

const emptyForm = {
  name: '',
  sku: '',
  costPrice: '',
  sellingPrice: '',
  reorderLevel: '10',
  trackingType: 'PIECE' as TrackingType,
  weightUnit: 'kg' as 'kg' | 'g',
  initialStock: '0',
};

export default function ProductsClient() {
  const [products, setProducts] = useState<Product[]>([]);
  const [branch, setBranch] = useState<Branch | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [barcodes, setBarcodes] = useState<string[]>(['']);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState(emptyForm);
  const [editBarcodes, setEditBarcodes] = useState<string[]>(['']);
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [stockProductId, setStockProductId] = useState<string | null>(null);
  const [stockDelta, setStockDelta] = useState('');
  const [stockError, setStockError] = useState<string | null>(null);
  const [stockSaving, setStockSaving] = useState(false);

  async function load() {
    const data = await apiFetch<{ products: Product[] }>('/api/products');
    setProducts(data.products);
  }

  async function loadBranch() {
    try {
      const data = await apiFetch<{ branches: Branch[] }>('/api/branches');
      setBranch(data.branches[0] ?? null);
    } catch {
      setBranch(null);
    }
  }

  useEffect(() => {
    load();
    loadBranch();
  }, []);

  async function createProduct(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const isWeight = form.trackingType === 'WEIGHT';
      const cleanBarcodes = barcodes.map((b) => b.trim()).filter((b) => b.length > 0);
      const result = await apiFetch<{ product: { id: string } }>('/api/products', {
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
          barcodes: cleanBarcodes,
        }),
      });

      const initialStock = Number(form.initialStock);
      if (initialStock > 0) {
        if (!branch) {
          setError('Product created, but no branch is configured — stock was not set. Ask the owner to set up a branch, then use "Add stock".');
        } else {
          await apiFetch('/api/inventory/adjust', {
            method: 'POST',
            body: JSON.stringify({
              productId: result.product.id,
              branchId: branch.id,
              delta: initialStock,
              reason: 'Initial stock on creation',
            }),
          });
        }
      }

      setForm(emptyForm);
      setBarcodes(['']);
      setShowForm(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create product');
    }
  }

  function openEdit(p: Product) {
    setEditingId(p.id);
    setEditError(null);
    setEditForm({
      name: p.name,
      sku: p.sku,
      costPrice: String(p.costPrice),
      sellingPrice: String(p.sellingPrice),
      reorderLevel: String(p.reorderLevel),
      trackingType: p.trackingType,
      weightUnit: (p.weightUnit as 'kg' | 'g') ?? 'kg',
      initialStock: '0',
    });
    setEditBarcodes(p.barcodes.length > 0 ? p.barcodes.map((b) => b.barcode) : ['']);
  }

  function closeEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    setEditError(null);
    setSaving(true);
    try {
      const isWeight = editForm.trackingType === 'WEIGHT';
      const cleanBarcodes = editBarcodes.map((b) => b.trim()).filter((b) => b.length > 0);
      await apiFetch(`/api/products/${editingId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editForm.name,
          sku: editForm.sku,
          costPrice: Number(editForm.costPrice),
          sellingPrice: Number(editForm.sellingPrice),
          reorderLevel: Number(editForm.reorderLevel),
          trackingType: editForm.trackingType,
          weightUnit: isWeight ? editForm.weightUnit : undefined,
          unit: isWeight ? editForm.weightUnit : 'pcs',
          barcodes: cleanBarcodes,
        }),
      });
      closeEdit();
      load();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update product');
    } finally {
      setSaving(false);
    }
  }

  async function deactivate(p: Product) {
    if (!confirm(`Deactivate "${p.name}"? It will no longer show up for sale, but past sales records are kept.`)) return;
    try {
      await apiFetch(`/api/products/${p.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to deactivate product');
    }
  }

  function openStock(p: Product) {
    setStockProductId(p.id);
    setStockDelta('');
    setStockError(null);
  }

  function closeStock() {
    setStockProductId(null);
    setStockError(null);
  }

  async function saveStock(e: React.FormEvent) {
    e.preventDefault();
    if (!stockProductId) return;
    if (!branch) {
      setStockError('No branch configured — ask the owner to set one up.');
      return;
    }
    const delta = Number(stockDelta);
    if (!delta) {
      setStockError('Enter a non-zero amount (negative to remove stock).');
      return;
    }
    setStockSaving(true);
    setStockError(null);
    try {
      await apiFetch('/api/inventory/adjust', {
        method: 'POST',
        body: JSON.stringify({
          productId: stockProductId,
          branchId: branch.id,
          delta,
          reason: 'Manual stock adjustment',
        }),
      });
      closeStock();
      load();
    } catch (err) {
      setStockError(err instanceof Error ? err.message : 'Failed to adjust stock');
    } finally {
      setStockSaving(false);
    }
  }

  const stockProduct = products.find((p) => p.id === stockProductId) ?? null;
  const stockIsWeight = stockProduct?.trackingType === 'WEIGHT';
  const stockUnitLabel = stockIsWeight ? stockProduct?.weightUnit ?? 'kg' : stockProduct?.unit || 'pcs';

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
        {!branch && (
          <p className="text-sm text-warn bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-4">
            No branch is configured yet — products can be created, but stock can't be recorded until a branch exists.
          </p>
        )}

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
                <Field label={`Initial stock (${form.weightUnit})`}>
                  <input type="number" step="0.001" min="0" value={form.initialStock} onChange={(e) => setForm({ ...form, initialStock: e.target.value })} className="input" />
                </Field>
                <p className="col-span-2 text-xs text-ink/40 pb-2">
                  Price and cost above are per {form.weightUnit}. Leave initial stock at 0 and use "Add stock" later if you don't have a starting count yet.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-5 gap-3 items-end">
                <Field label="Low-stock alert (units)">
                  <input required type="number" step="1" value={form.reorderLevel} onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })} className="input" />
                </Field>
                <Field label="Initial stock (units)">
                  <input type="number" step="1" min="0" value={form.initialStock} onChange={(e) => setForm({ ...form, initialStock: e.target.value })} className="input" />
                </Field>
              </div>
            )}

            <BarcodeFields values={barcodes} onChange={setBarcodes} />

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
                <th className="px-4 py-3 font-medium text-right">Actions</th>
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
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button onClick={() => openStock(p)} className="text-ink/60 hover:text-ink text-xs font-medium mr-3">
                        Add stock
                      </button>
                      <button onClick={() => openEdit(p)} className="text-brand-600 hover:text-brand-700 text-xs font-medium mr-3">
                        Edit
                      </button>
                      <button onClick={() => deactivate(p)} className="text-danger hover:opacity-80 text-xs font-medium">
                        Deactivate
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </main>

      {editingId && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <form onSubmit={saveEdit} className="bg-white rounded-xl p-6 w-full max-w-lg space-y-3">
            <h2 className="text-base font-semibold mb-1">Edit product</h2>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Name"><input required value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="input" /></Field>
              <Field label="SKU"><input required value={editForm.sku} onChange={(e) => setEditForm({ ...editForm, sku: e.target.value })} className="input" /></Field>
              <Field label="Cost price"><input required type="number" step="0.01" value={editForm.costPrice} onChange={(e) => setEditForm({ ...editForm, costPrice: e.target.value })} className="input" /></Field>
              <Field label="Selling price"><input required type="number" step="0.01" value={editForm.sellingPrice} onChange={(e) => setEditForm({ ...editForm, sellingPrice: e.target.value })} className="input" /></Field>
              <Field label="Sold by">
                <select
                  value={editForm.trackingType}
                  onChange={(e) => setEditForm({ ...editForm, trackingType: e.target.value as TrackingType })}
                  className="input"
                >
                  <option value="PIECE">Piece / unit</option>
                  <option value="WEIGHT">Weight (loose)</option>
                </select>
              </Field>
              {editForm.trackingType === 'WEIGHT' ? (
                <Field label="Weight unit">
                  <select
                    value={editForm.weightUnit}
                    onChange={(e) => setEditForm({ ...editForm, weightUnit: e.target.value as 'kg' | 'g' })}
                    className="input"
                  >
                    <option value="kg">Kilograms (kg)</option>
                    <option value="g">Grams (g)</option>
                  </select>
                </Field>
              ) : (
                <Field label="Low-stock alert (units)">
                  <input required type="number" step="1" value={editForm.reorderLevel} onChange={(e) => setEditForm({ ...editForm, reorderLevel: e.target.value })} className="input" />
                </Field>
              )}
              {editForm.trackingType === 'WEIGHT' && (
                <Field label={`Low-stock alert (${editForm.weightUnit})`}>
                  <input required type="number" step="0.001" value={editForm.reorderLevel} onChange={(e) => setEditForm({ ...editForm, reorderLevel: e.target.value })} className="input" />
                </Field>
              )}
            </div>

            <BarcodeFields values={editBarcodes} onChange={setEditBarcodes} />

            {editError && <p className="text-sm text-danger">{editError}</p>}

            <div className="flex items-center gap-3 pt-1">
              <button type="submit" disabled={saving} className="rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-60 text-white text-sm font-medium px-4 py-2.5">
                {saving ? 'Saving…' : 'Save changes'}
              </button>
              <button type="button" onClick={closeEdit} className="text-sm text-ink/60 hover:text-ink">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {stockProductId && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <form onSubmit={saveStock} className="bg-white rounded-xl p-6 w-full max-w-sm space-y-3">
            <h2 className="text-base font-semibold mb-1">Add stock — {stockProduct?.name}</h2>
            <Field label={`Amount to add (${stockUnitLabel}) — use a negative number to remove stock`}>
              <input
                autoFocus
                required
                type="number"
                step={stockIsWeight ? '0.001' : '1'}
                value={stockDelta}
                onChange={(e) => setStockDelta(e.target.value)}
                className="input"
                placeholder={stockIsWeight ? 'e.g. 25.5' : 'e.g. 50'}
              />
            </Field>
            {stockError && <p className="text-sm text-danger">{stockError}</p>}
            <div className="flex items-center gap-3 pt-1">
              <button type="submit" disabled={stockSaving} className="rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-60 text-white text-sm font-medium px-4 py-2.5">
                {stockSaving ? 'Saving…' : 'Save'}
              </button>
              <button type="button" onClick={closeStock} className="text-sm text-ink/60 hover:text-ink">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
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

/**
 * Editable list of barcodes for a product. Defaults to a single field
 * (most products have one barcode), with an "add another" option for
 * the ones that legitimately have more — e.g. a case/carton barcode
 * alongside the single-unit barcode. Blank fields are dropped before
 * the form submits, so leaving it empty is fine.
 */
function BarcodeFields({ values, onChange }: { values: string[]; onChange: (next: string[]) => void }) {
  function updateAt(i: number, value: string) {
    const next = [...values];
    next[i] = value;
    onChange(next);
  }

  function addField() {
    onChange([...values, '']);
  }

  function removeAt(i: number) {
    const next = values.filter((_, idx) => idx !== i);
    onChange(next.length > 0 ? next : ['']);
  }

  return (
    <div className="space-y-2">
      <span className="block text-xs text-ink/50">Barcode{values.length > 1 ? 's' : ''}</span>
      {values.map((value, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            value={value}
            onChange={(e) => updateAt(i, e.target.value)}
            placeholder="Scan or type a barcode (optional)"
            className="input flex-1"
          />
          {values.length > 1 && (
            <button
              type="button"
              onClick={() => removeAt(i)}
              className="text-xs text-danger hover:opacity-80 px-1 whitespace-nowrap"
            >
              Remove
            </button>
          )}
        </div>
      ))}
      <button type="button" onClick={addField} className="text-xs font-medium text-brand-600 hover:text-brand-700">
        + Add another barcode
      </button>
    </div>
  );
}