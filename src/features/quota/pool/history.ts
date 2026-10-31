/**
 * Recorded quota history (`history.json`), written by the hub-side recorder.
 *
 * This file is not part of the Management API: Tailscale Serve publishes it next
 * to management.html, so it is fetched same-origin with a plain `fetch` rather
 * than through apiClient. It is optional; a missing file means "no recorded
 * line" and the pool view shows the projection only.
 *
 * Wire format (epoch seconds, `w` = weekly, `f` = 5-hour, 0..100):
 * `{ version: 1, interval, updated, samples: [{ t, a: [{ id, p, on, w, f, seen, src, plan? }] }] }`
 */

import { normalizeAuthIndex } from '@/utils/authIndex';
import { isRecord } from '@/utils/helpers';
import { readInstantMs } from './signals';
import type { HistoryAccountSample, HistorySample, HistoryWindow, QuotaHistory } from './types';

/** Root-relative: resolves against the page origin wherever management.html is served. */
export const QUOTA_HISTORY_URL = '/quota-history/history.json';
export const DEFAULT_HISTORY_INTERVAL_MS = 300_000;

const readWindow = (value: unknown): HistoryWindow | null => {
  if (!isRecord(value)) return null;
  const used = typeof value.used === 'number' ? value.used : Number(value.used);
  if (!Number.isFinite(used)) return null;
  return {
    used: Math.min(100, Math.max(0, used)),
    resetAtMs: readInstantMs(value.reset as number | string | undefined),
  };
};

const readAccount = (value: unknown): HistoryAccountSample | null => {
  if (!isRecord(value)) return null;
  const id = normalizeAuthIndex(value.id);
  if (!id) return null;
  const src = typeof value.src === 'string' && value.src ? value.src : undefined;
  const plan = typeof value.plan === 'string' && value.plan.trim() ? value.plan.trim() : undefined;
  return {
    id,
    provider: typeof value.p === 'string' ? value.p.trim().toLowerCase() : '',
    on: value.on !== false,
    weekly: readWindow(value.w),
    fiveHour: readWindow(value.f),
    seenMs: readInstantMs(value.seen as number | string | undefined),
    ...(src ? { src } : {}),
    ...(plan ? { plan } : {}),
  };
};

export function normalizeQuotaHistory(payload: unknown): QuotaHistory | null {
  if (!isRecord(payload) || !Array.isArray(payload.samples)) return null;
  if (payload.version !== undefined && payload.version !== 1) return null;

  const intervalSeconds = Number(payload.interval);
  const samples: HistorySample[] = [];
  for (const raw of payload.samples) {
    if (!isRecord(raw)) continue;
    const t = readInstantMs(raw.t as number | string | undefined);
    if (t === null) continue;
    const accounts = Array.isArray(raw.a)
      ? raw.a.map(readAccount).filter((item): item is HistoryAccountSample => item !== null)
      : [];
    samples.push({ t, accounts });
  }
  samples.sort((left, right) => left.t - right.t);

  return {
    intervalMs:
      Number.isFinite(intervalSeconds) && intervalSeconds > 0
        ? intervalSeconds * 1000
        : DEFAULT_HISTORY_INTERVAL_MS,
    updatedMs: readInstantMs(payload.updated as number | string | undefined),
    samples,
  };
}

export type HistoryFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * `null` when the file is absent (404) or is not history JSON (an SPA fallback
 * page, say). Other HTTP failures throw so the caller can keep its last copy.
 */
export async function fetchQuotaHistory(
  fetchImpl: HistoryFetch = (input, init) => fetch(input, init),
  signal?: AbortSignal
): Promise<QuotaHistory | null> {
  const response = await fetchImpl(QUOTA_HISTORY_URL, {
    // Revalidate instead of re-downloading: the file only changes every interval.
    cache: 'no-cache',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  return normalizeQuotaHistory(payload);
}
