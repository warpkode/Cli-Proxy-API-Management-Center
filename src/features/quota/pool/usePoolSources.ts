/**
 * Hub-cached quota sources with a visible-tab poll.
 *
 * Loads once on mount and then every POOL_POLL_INTERVAL_MS while the document
 * is visible (a hidden tab skips ticks and catches up when shown again). Every
 * request here reads hub caches; see sources.ts for the exact endpoints.
 *
 * Stale responses are dropped by request id and by the quota cache generation,
 * so a reply from before a connection switch never lands in the new session.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SeatPacerStatus } from '@/services/api/seatPacer';
import { useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { loadPoolSources, POOL_POLL_INTERVAL_MS, shouldReloadHistory } from './sources';
import type { QuotaHistory } from './types';

/** `unsupported`: backend without plugins; `absent`: 404 / no file. */
export type OptionalSourceState = 'idle' | 'ok' | 'absent' | 'error' | 'unsupported';

export interface PoolSourcesState {
  files: AuthFileItem[];
  /** Session generation the current file list belongs to; null before the first list. */
  filesGeneration: number | null;
  /** True until the first credential list settles. */
  loading: boolean;
  refreshing: boolean;
  error: string;
  seatPacer: SeatPacerStatus | null;
  seatPacerState: OptionalSourceState;
  history: QuotaHistory | null;
  historyState: OptionalSourceState;
}

const INITIAL_STATE: PoolSourcesState = {
  files: [],
  filesGeneration: null,
  loading: true,
  refreshing: false,
  error: '',
  seatPacer: null,
  seatPacerState: 'idle',
  history: null,
  historyState: 'idle',
};

export interface UsePoolSourcesOptions {
  connected: boolean;
  supportsPlugin: boolean;
  errorFallback: string;
}

const messageOf = (reason: unknown, fallback: string) =>
  reason instanceof Error && reason.message ? reason.message : fallback;

export function usePoolSources({
  connected,
  supportsPlugin,
  errorFallback,
}: UsePoolSourcesOptions) {
  const sessionGeneration = useQuotaStore((state) => state.cacheGeneration);
  const [state, setState] = useState<PoolSourcesState>(INITIAL_STATE);
  const requestRef = useRef(0);
  const inFlightRef = useRef(false);
  const lastRefreshRef = useRef(0);
  const historyLoadedAtRef = useRef<number | null>(null);
  const historyIntervalRef = useRef<number | null>(null);
  const seatPacerAbsentRef = useRef(false);

  const load = useCallback(
    async (force: boolean) => {
      if (!force && inFlightRef.current) return;
      const requestId = ++requestRef.current;
      if (!connected) {
        inFlightRef.current = false;
        setState({ ...INITIAL_STATE, loading: false });
        return;
      }
      const isCurrent = () =>
        requestId === requestRef.current &&
        sessionGeneration === useQuotaStore.getState().cacheGeneration;

      const startedAt = Date.now();
      const includeHistory = shouldReloadHistory(
        force,
        historyLoadedAtRef.current,
        historyIntervalRef.current,
        startedAt
      );
      const includeSeatPacer = supportsPlugin && (force || !seatPacerAbsentRef.current);
      inFlightRef.current = true;
      setState((prev) => ({ ...prev, refreshing: true }));

      try {
        const result = await loadPoolSources({ includeSeatPacer, includeHistory });
        if (!isCurrent()) return;
        const settledAt = Date.now();
        lastRefreshRef.current = settledAt;
        if (includeHistory) historyLoadedAtRef.current = settledAt;
        if (result.history?.status === 'fulfilled') {
          historyIntervalRef.current = result.history.value?.intervalMs ?? null;
        }
        if (result.seatPacer?.status === 'fulfilled') {
          seatPacerAbsentRef.current = result.seatPacer.value === null;
        }

        setState((prev) => {
          const next: PoolSourcesState = { ...prev, loading: false, refreshing: false };
          if (result.credentials.status === 'fulfilled') {
            next.files = result.credentials.value?.files ?? [];
            next.filesGeneration = sessionGeneration;
            next.error = '';
          } else {
            next.error = messageOf(result.credentials.reason, errorFallback);
          }

          if (!supportsPlugin) {
            next.seatPacer = null;
            next.seatPacerState = 'unsupported';
          } else if (result.seatPacer?.status === 'fulfilled') {
            next.seatPacer = result.seatPacer.value;
            next.seatPacerState = result.seatPacer.value ? 'ok' : 'absent';
          } else if (result.seatPacer?.status === 'rejected') {
            // Keep the last snapshot: one failed poll should not blank the view.
            next.seatPacerState = 'error';
          }

          if (result.history?.status === 'fulfilled') {
            next.history = result.history.value;
            next.historyState = result.history.value ? 'ok' : 'absent';
          } else if (result.history?.status === 'rejected') {
            next.historyState = 'error';
          }
          return next;
        });
      } finally {
        if (requestId === requestRef.current) inFlightRef.current = false;
      }
    },
    [connected, errorFallback, sessionGeneration, supportsPlugin]
  );

  // Initial load, and a clean slate whenever the session or connection changes.
  useEffect(() => {
    historyLoadedAtRef.current = null;
    historyIntervalRef.current = null;
    seatPacerAbsentRef.current = false;
    void load(true);
    return () => {
      requestRef.current += 1;
      inFlightRef.current = false;
    };
  }, [load]);

  // Visible-tab poll of the hub caches.
  useEffect(() => {
    if (!connected || typeof document === 'undefined') return;
    const tick = () => {
      if (document.visibilityState === 'hidden') return;
      void load(false);
    };
    const id = window.setInterval(tick, POOL_POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastRefreshRef.current >= POOL_POLL_INTERVAL_MS) void load(false);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [connected, load]);

  const refresh = useCallback(() => load(true), [load]);

  return { ...state, sessionGeneration, refresh };
}
