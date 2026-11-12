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

/**
 * Which weekly limit a pool is measured against: the account-wide one (`all`)
 * or the weekly limit Anthropic scopes to Fable (`fable`).
 */
export const POOL_SCOPES = ['all', 'fable'] as const;
export type PoolScope = (typeof POOL_SCOPES)[number];

export const isPoolScope = (value: unknown): value is PoolScope =>
  typeof value === 'string' && (POOL_SCOPES as readonly string[]).includes(value);

const ALL_ONLY: readonly PoolScope[] = ['all'];

/** Only Claude reports a model-scoped weekly limit next to the account-wide one. */
export const poolScopesFor = (provider: PoolProvider): readonly PoolScope[] =>
  provider === 'claude' ? POOL_SCOPES : ALL_ONLY;

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
  /** Claude's Fable-scoped weekly window; other providers never report one. */
  fable?: QuotaWindowReading | null;
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
  /** The Fable-scoped weekly window, from its own freshest reading. */
  fable?: ResolvedWindow | null;
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
  /** Recorded only once the hub's recorder writes the Fable window. */
  fable?: HistoryWindow | null;
  seenMs: number | null;
  src?: string;
  plan?: string;
}

/** The window a scope measures on a resolved account. */
export const scopedWindow = (
  quota: ResolvedAccountQuota,
  scope: PoolScope
): ResolvedWindow | null => (scope === 'fable' ? quota.fable : quota.weekly) ?? null;

/** The window a scope measures in one recorded sample. */
export const scopedHistoryWindow = (
  sample: HistoryAccountSample,
  scope: PoolScope
): HistoryWindow | null => (scope === 'fable' ? sample.fable : sample.weekly) ?? null;

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
