'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api-client';

/**
 * "Activate M-Pesa capture" — wraps gateway/scripts/register_c2b_urls.php
 * so the owner can (re)register the C2B Confirmation/Validation URLs
 * from the till instead of visiting a raw PHP script URL. Only useful
 * in gateway mode (see api-client.ts GATEWAY_ROUTES) — there's no
 * Next.js-direct equivalent of C2B registration yet.
 *
 * Safe to click repeatedly: registering the same URLs again is a
 * no-op on Daraja's side, not a duplicate/error.
 */
export function MpesaCaptureButton() {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<{
    confirmationUrl?: string;
    validationUrl?: string;
    darajaStatus?: number;
    darajaResponse?: unknown;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function activate() {
    setState('loading');
    setError(null);
    setResult(null);
    try {
      const data = await apiFetch<{
        confirmationUrl: string;
        validationUrl: string;
        darajaStatus: number;
        darajaResponse: unknown;
      }>('/api/settings/mpesa/register-c2b');
      setResult(data);
      setState(data.darajaStatus === 200 ? 'done' : 'error');
      if (data.darajaStatus !== 200) {
        setError('Safaricom did not confirm the registration — see details below.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to activate M-Pesa capture');
      setState('error');
    }
  }

  return (
    <div className="relative">
      <button
        onClick={activate}
        disabled={state === 'loading'}
        title="Registers this server's URL with Safaricom so direct/walk-in Paybill or Till payments (no STK push) get captured automatically."
        className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
          state === 'done'
            ? 'border-brand-200 bg-brand-50 text-brand-700'
            : state === 'error'
            ? 'border-red-200 bg-red-50 text-red-700'
            : 'border-black/10 text-ink/50 hover:bg-black/5'
        }`}
      >
        {state === 'loading' ? 'Activating…' : state === 'done' ? 'M-Pesa capture active ✓' : 'Activate M-Pesa capture'}
      </button>

      {(result || error) && (
        <div className="absolute right-0 mt-2 w-80 bg-white border border-black/10 rounded-lg shadow-lg p-3 text-xs z-20">
          {error && <p className="text-red-600 mb-2">{error}</p>}
          {result && (
            <>
              <p className="text-ink/60 mb-1">
                Confirmation URL: <span className="break-all">{result.confirmationUrl}</span>
              </p>
              <p className="text-ink/60 mb-1">
                Validation URL: <span className="break-all">{result.validationUrl}</span>
              </p>
              <p className="text-ink/40">
                Daraja status: {String(result.darajaStatus)} —{' '}
                <span className="break-all">{JSON.stringify(result.darajaResponse)}</span>
              </p>
            </>
          )}
          <button onClick={() => { setResult(null); setError(null); setState('idle'); }} className="mt-2 text-ink/40 hover:text-ink">
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}