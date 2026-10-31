/**
 * Pooled quota model types. React-free; consumed by poolModel.ts and the pool UI.
 *
 * Units: every `used` / `remaining` is a percentage of one account's window
 * (0..100). A pool of N accounts therefore holds N×100%.
 */

/** Providers with a pooled weekly view. */
export const POOL_PROVIDERS = ['claude', 'codex'] as const;
export type PoolProvider = (typeof POOL_PROVIDERS)[number];

export const isPoolProvider = (value: unknown): value is PoolProvider =>
  typeof value === 'string' && (POOL_PROVIDERS as readonly string[]).includes(value);

/** Where a reading came from, in preference order. */
export type QuotaReadingSource = 'seat-pacer' | 'signals' | 'history';

export interface QuotaWindowReading {
  /** 0..100 */
  used: number;
  resetAtMs: number | null;
  /** Window length, used to roll a passed reset forward. */
  periodMs: number;
  /** Upstream status for the window, e.g. Anthropic's `allowed` / `rejected`. */
  status?: string;
}

/** One observation of an account's windows from a single source. */
export interface QuotaReading {
  source: QuotaReadingSource;
  observedAtMs: number | null;
  weekly: QuotaWindowReading | null;
  fiveHour: QuotaWindowReading | null;
  plan?: string;
}

/** A window after applying "now": a passed reset reads as a fresh window. */
export interface ResolvedWindow {
  used: number;
  resetAtMs: number | null;
  periodMs: number;
  /** True when the observed reset already passed and the window was rolled forward. */
  rolled: boolean;
  status?: string;
}

export interface ResolvedAccountQuota {
  weekly: ResolvedWindow | null;
  fiveHour: ResolvedWindow | null;
  /** Source and time of the weekly reading (or the 5-hour one when weekly is absent). */
  source: QuotaReadingSource | null;
  observedAtMs: number | null;
  plan?: string;
}

/** history.json, normalized (milliseconds, sorted ascending). */
export interface HistoryWindow {
  used: number;
  resetAtMs: number | null;
}

export interface HistoryAccountSample {
  id: string;
  provider: string;
  on: boolean;
  weekly: HistoryWindow | null;
  fiveHour: HistoryWindow | null;
  seenMs: number | null;
  src?: string;
  plan?: string;
}

export interface HistorySample {
  t: number;
  accounts: HistoryAccountSample[];
}

export interface QuotaHistory {
  intervalMs: number;
  updatedMs: number | null;
  samples: HistorySample[];
}

export interface SeriesPoint {
  t: number;
  value: number;
}

export interface StepUpEvent {
  t: number;
  /** Percentage points restored (summed across accounts resetting together). */
  amount: number;
  accountIds: string[];
  /** `grant`: a reset grant or credit was spent; absent or `reset`: the weekly window reset. */
  kind?: 'reset' | 'grant';
  grantId?: string;
}
