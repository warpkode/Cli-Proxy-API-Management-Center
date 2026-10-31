/**
 * The pool view's data loads. All three read data the hub already holds; none
 * of them reaches an upstream provider:
 * - `GET /v8/management/credentials` (cached rate-limit headers per credential);
 * - `GET /v0/management/plugins/claude-seat-pacer/status` (plugin snapshots),
 *   only when the backend advertises plugin support;
 * - same-origin `GET /quota-history/history.json` (recorder output).
 *
 * Per-account upstream checks (`POST /v8/management/requests/api-call`) belong
 * to the explicit "Live account checks" actions and never run from here.
 */

import { authFilesApi } from '@/services/api/authFiles';
import { seatPacerApi, type SeatPacerStatus } from '@/services/api/seatPacer';
import type { AuthFilesResponse } from '@/types';
import { MINUTE_MS } from '@/utils/time/durations';
import { fetchQuotaHistory } from './history';
import type { QuotaHistory } from './types';

/** Hub-cached sources refresh this often while the tab is visible. */
export const POOL_POLL_INTERVAL_MS = MINUTE_MS;

export interface PoolSourceDeps {
  listCredentials: () => Promise<AuthFilesResponse>;
  seatPacerStatus: () => Promise<SeatPacerStatus | null>;
  fetchHistory: () => Promise<QuotaHistory | null>;
}

export const defaultPoolSourceDeps: PoolSourceDeps = {
  listCredentials: () => authFilesApi.list(),
  seatPacerStatus: () => seatPacerApi.status(),
  fetchHistory: () => fetchQuotaHistory(),
};

export interface PoolSourceRequest {
  includeSeatPacer: boolean;
  includeHistory: boolean;
}

export interface PoolSourceResult {
  credentials: PromiseSettledResult<AuthFilesResponse>;
  seatPacer: PromiseSettledResult<SeatPacerStatus | null> | null;
  history: PromiseSettledResult<QuotaHistory | null> | null;
}

/** Load the requested sources in parallel; one failing never blocks the others. */
export async function loadPoolSources(
  request: PoolSourceRequest,
  deps: PoolSourceDeps = defaultPoolSourceDeps
): Promise<PoolSourceResult> {
  const [credentials, seatPacer, history] = await Promise.allSettled([
    deps.listCredentials(),
    request.includeSeatPacer ? deps.seatPacerStatus() : Promise.resolve(undefined),
    request.includeHistory ? deps.fetchHistory() : Promise.resolve(undefined),
  ]);
  return {
    credentials,
    seatPacer: request.includeSeatPacer
      ? (seatPacer as PromiseSettledResult<SeatPacerStatus | null>)
      : null,
    history: request.includeHistory ? (history as PromiseSettledResult<QuotaHistory | null>) : null,
  };
}

/**
 * The history file only changes once per recorder interval, so automatic ticks
 * skip it until an interval has passed. Explicit refreshes always reload it.
 */
export function shouldReloadHistory(
  force: boolean,
  lastLoadedAtMs: number | null,
  intervalMs: number | null,
  nowMs: number
): boolean {
  if (force || lastLoadedAtMs === null) return true;
  return nowMs - lastLoadedAtMs >= Math.max(POOL_POLL_INTERVAL_MS, intervalMs ?? 0);
}
