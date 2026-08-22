'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Weighing-scale integration.
 *
 * A browser tab cannot talk to an RS232/USB scale directly, so the
 * actual serial communication happens in a small local helper program
 * — the "scale bridge" (see /scale-bridge in the repo root). That
 * bridge reads the scale and re-broadcasts each weight reading over a
 * plain local WebSocket, which this hook connects to.
 *
 * This is entirely optional: if the bridge isn't running (no scale
 * plugged in, or a shop that doesn't have one), the connection simply
 * fails to open and `connected` stays false — cashiers just type the
 * weight in by hand instead. Nothing else in the POS depends on this.
 */

export interface ScaleReading {
  /** Weight in the unit the bridge is configured for (see scale-bridge/.env → SCALE_UNIT). */
  weight: number;
  unit: 'kg' | 'g';
  /** True once the scale reports the reading has settled (not still moving). Most indicators send this; if yours doesn't, it's always true. */
  stable: boolean;
}

const DEFAULT_BRIDGE_URL =
  (typeof window !== 'undefined' && (window as any).__SCALE_BRIDGE_URL__) ||
  process.env.NEXT_PUBLIC_SCALE_BRIDGE_URL ||
  'ws://localhost:4501';

// Master kill switch. Set NEXT_PUBLIC_SCALE_ENABLED=false in .env to
// stop the app from ever attempting the scale-bridge connection — no
// WebSocket is opened at all, so there's no "connection failed"
// console noise and no background retry loop. Cashiers simply type
// weights in by hand, same as when a scale is temporarily unplugged.
// Defaults to enabled (true) so existing deployments are unaffected;
// only an explicit "false" turns it off.
const SCALE_ENABLED = process.env.NEXT_PUBLIC_SCALE_ENABLED !== 'false';

type Status = 'idle' | 'connecting' | 'connected' | 'unavailable';

export function useScale(bridgeUrl: string = DEFAULT_BRIDGE_URL) {
  const [status, setStatus] = useState<Status>(SCALE_ENABLED ? 'idle' : 'unavailable');
  const [reading, setReading] = useState<ScaleReading | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    if (!SCALE_ENABLED) return; // scale disabled — skip connecting entirely
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (retryRef.current) clearTimeout(retryRef.current);
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridgeUrl]);

  function connect() {
    if (!mountedRef.current) return;
    setStatus((s) => (s === 'connected' ? s : 'connecting'));
    let ws: WebSocket;
    try {
      ws = new WebSocket(bridgeUrl);
    } catch {
      scheduleRetry();
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setStatus('connected');
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      try {
        const data = JSON.parse(event.data);
        if (typeof data.weight === 'number') {
          setReading({
            weight: data.weight,
            unit: data.unit === 'g' ? 'g' : 'kg',
            stable: data.stable !== false,
          });
        }
      } catch {
        // ignore malformed frames from the bridge
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setStatus('unavailable');
      scheduleRetry();
    };

    ws.onerror = () => {
      // onclose will fire right after; nothing extra to do here.
    };
  }

  function scheduleRetry() {
    if (retryRef.current) clearTimeout(retryRef.current);
    // Slow, quiet retry — this is a "connect if present" feature, not
    // something that should spam retries or alarm the cashier.
    retryRef.current = setTimeout(() => {
      if (mountedRef.current) connect();
    }, 8000);
  }

  return {
    /** 'connected' = bridge reachable and streaming; 'unavailable'/'connecting' = no live scale right now (manual entry still works fine). */
    status,
    connected: status === 'connected',
    reading,
  };
}
