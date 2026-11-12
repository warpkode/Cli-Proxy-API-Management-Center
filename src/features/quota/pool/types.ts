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
 * What a pool measures: the whole weekly limit (`all`), or the part of it that
 * can still be spent on Fable (`fable`). Both read in percent of one account's
 * weekly limit, so the Fable figure is never more than the all-models one.
 */
export const POOL_SCOPES = ['all', 'fable'] as const;
export type PoolScope = (typeof POOL_SCOPES)[number];

/**
 * The share of an account's weekly limit that Fable may use. Anthropic's help
 * center ("Claude Fable models on your plan"): "You can use up to 50% of your
 * weekly usage limits on Fable models", and that use draws from the regular
 * weekly limit. The Fable meter reads in percent of this share, so one point on
 * it is half a point of the weekly limit.
 */
export const FABLE_WEEKLY_SHARE = 0.5;

/** One point on a scope's own meter, in points of the weekly limit. */
export const scopeShare = (scope: PoolScope) => (scope === 'fable' ? FABLE_WEEKLY_SHARE : 1);

/** The most one account can hold for a scope, in percent of its weekly limit. */
export const scopeCapacity = (scope: PoolScope) => 100 * scopeShare(scope);

/**
 * What a scope has left on one account, in percent of its weekly limit. `used`
 * is the scope's own meter (0..100). Fable also draws on the weekly limit, so it
 * has the smaller of its allowance left and `weeklyLeft` (null: unknown).
 */
export function scopeLeft(scope: PoolScope, used: number, weeklyLeft: number | null): number {
  if (scope === 'all') return 100 - used;
  const allowance = FABLE_WEEKLY_SHARE * (100 - used);
  return weeklyLeft === null ? allowance : Math.min(allowance, weeklyLeft);
}

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
  /**
   * Claude's Fable meter: 0..100 over the share of the weekly limit Fable may
   * use. Other providers never report one.
   */
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
  /** The Fable meter, from its own freshest reading (see scopeLeft for what is usable). */
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

/** The meter a scope reads on a resolved account. */
export const scopedWindow = (
  quota: ResolvedAccountQuota,
  scope: PoolScope
): ResolvedWindow | null => (scope === 'fable' ? quota.fable : quota.weekly) ?? null;

/** The meter a scope reads in one recorded sample. */
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
