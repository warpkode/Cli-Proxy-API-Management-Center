/**
 * Pooled quota projection. Pure and clock-free: every function takes `nowMs`.
 *
 * Rules (covered by tests/quotaPoolModel.test.ts):
 * - Current state per account prefers the fresher of the seat-pacer snapshot and
 *   the hub's cached credential signals (seat-pacer wins ties), then falls back to
 *   the latest recorded history sample. A window whose reset already passed reads
 *   as fresh: used 0, next reset rolled forward by whole periods.
 * - Burn rate sums the positive per-account increases in weekly `used` between
 *   consecutive history samples inside the window; drops are resets and are
 *   ignored. The sum is divided by the hours the samples actually cover. Too
 *   little coverage yields 0 and `sufficient: false`.
 * - The forward simulation runs in 15-minute steps. Each step's demand drains
 *   the account with the soonest weekly reset that still has quota, overflowing
 *   to the next one. An account's reset restores it to 100 and moves its reset
 *   one period on, recording a step-up of whatever it had used.
 * - Reset grants follow the hub scheduler's policies: `expiry` spends one
 *   `leadMs` before the grant expires, `limit` when the account runs dry, `off`
 *   never. A grant that requires the limit (Claude) is refused while the account
 *   has quota; an `expiry` grant then keeps waiting for the limit until it expires.
 */

import { HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import { WEEK_MS } from './signals';
import type {
  HistorySample,
  HistoryWindow,
  QuotaReading,
  QuotaWindowReading,
  ResolvedAccountQuota,
  ResolvedWindow,
  SeriesPoint,
  StepUpEvent,
} from './types';

export const SIMULATION_STEP_MS = 15 * MINUTE_MS;
/** Burn needs samples spanning at least this share of the selected window. */
export const MIN_BURN_COVERAGE = 0.5;
export const BURN_WINDOWS_HOURS = [1, 3, 6] as const;
export type BurnWindowHours = (typeof BURN_WINDOWS_HOURS)[number];

export const FUTURE_USAGE_FACTORS = { same: 1, half: 0.5, double: 2, none: 0 } as const;
export type FutureUsageMode = keyof typeof FUTURE_USAGE_FACTORS;

const EPSILON = 1e-9;
const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

/* ------------------------------------------------------------------------ */
/* Current state                                                            */
/* ------------------------------------------------------------------------ */

/** Apply "now" to a window: a passed reset means a fresh, unused window. */
export function rollWindow(reading: QuotaWindowReading, nowMs: number): ResolvedWindow {
  const periodMs = reading.periodMs > 0 ? reading.periodMs : WEEK_MS;
  if (reading.resetAtMs !== null && nowMs >= reading.resetAtMs) {
    const periods = Math.floor((nowMs - reading.resetAtMs) / periodMs) + 1;
    return {
      used: 0,
      resetAtMs: reading.resetAtMs + periods * periodMs,
      periodMs,
      rolled: true,
    };
  }
  return {
    used: clampPercent(reading.used),
    resetAtMs: reading.resetAtMs,
    periodMs,
    rolled: false,
    ...(reading.status ? { status: reading.status } : {}),
  };
}

const SOURCE_RANK: Record<QuotaReading['source'], number> = {
  'seat-pacer': 0,
  signals: 1,
  history: 2,
};

const fresherFirst = (left: QuotaReading, right: QuotaReading) => {
  const leftAt = left.observedAtMs ?? Number.NEGATIVE_INFINITY;
  const rightAt = right.observedAtMs ?? Number.NEGATIVE_INFINITY;
  if (leftAt !== rightAt) return rightAt - leftAt > 0 ? 1 : -1;
  return SOURCE_RANK[left.source] - SOURCE_RANK[right.source];
};

/**
 * Choose the reading for one window kind: the freshest live reading (seat-pacer
 * or credential signals, seat-pacer on ties), else the latest history sample.
 */
export function pickReading(
  readings: readonly QuotaReading[],
  kind: 'weekly' | 'fiveHour'
): QuotaReading | null {
  const withWindow = readings.filter((reading) => reading[kind] !== null);
  const live = withWindow.filter((reading) => reading.source !== 'history').sort(fresherFirst);
  if (live.length > 0) return live[0];
  const history = withWindow.filter((reading) => reading.source === 'history').sort(fresherFirst);
  return history[0] ?? null;
}

export function resolveAccountQuota(
  readings: readonly QuotaReading[],
  nowMs: number
): ResolvedAccountQuota {
  const weeklyReading = pickReading(readings, 'weekly');
  const fiveHourReading = pickReading(readings, 'fiveHour');
  const primary = weeklyReading ?? fiveHourReading;
  const plan = readings.find((reading) => reading.plan)?.plan;
  return {
    weekly: weeklyReading?.weekly ? rollWindow(weeklyReading.weekly, nowMs) : null,
    fiveHour: fiveHourReading?.fiveHour ? rollWindow(fiveHourReading.fiveHour, nowMs) : null,
    source: primary?.source ?? null,
    observedAtMs: primary?.observedAtMs ?? null,
    ...(plan ? { plan } : {}),
  };
}

/* ------------------------------------------------------------------------ */
/* History: burn rate and recorded series                                   */
/* ------------------------------------------------------------------------ */

/** `used` as of `atMs`: a recorded window whose reset has passed reads as 0. */
export const effectiveUsed = (window: HistoryWindow, atMs: number): number =>
  window.resetAtMs !== null && atMs >= window.resetAtMs ? 0 : window.used;

export interface BurnIndex {
  times: number[];
  /** prefix[i] = summed positive increases up to and including sample i. */
  prefix: number[];
}

/**
 * Per-sample pooled increase, as a prefix sum. An account missing from a sample
 * keeps its last value, so a gap is bridged rather than read as a reset.
 */
export function buildBurnIndex(
  samples: readonly HistorySample[],
  accountIds: ReadonlySet<string>
): BurnIndex {
  const last = new Map<string, number>();
  const times: number[] = new Array(samples.length);
  const prefix: number[] = new Array(samples.length);
  let running = 0;
  samples.forEach((sample, index) => {
    for (const account of sample.accounts) {
      if (!account.weekly || !accountIds.has(account.id)) continue;
      const used = effectiveUsed(account.weekly, sample.t);
      const previous = last.get(account.id);
      if (previous !== undefined && used > previous) running += used - previous;
      last.set(account.id, used);
    }
    times[index] = sample.t;
    prefix[index] = running;
  });
  return { times, prefix };
}

/** First index with times[index] >= target. */
const lowerBound = (times: readonly number[], target: number) => {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

export interface BurnRate {
  /** Percentage points per hour across the pool. */
  ratePerHour: number;
  coveredHours: number;
  sufficient: boolean;
}

export function computeBurnRate(index: BurnIndex, endMs: number, windowHours: number): BurnRate {
  const startMs = endMs - windowHours * HOUR_MS;
  const first = lowerBound(index.times, startMs);
  const last = lowerBound(index.times, endMs + 1) - 1;
  if (last <= first) return { ratePerHour: 0, coveredHours: 0, sufficient: false };
  const coveredHours = (index.times[last] - index.times[first]) / HOUR_MS;
  if (coveredHours < windowHours * MIN_BURN_COVERAGE) {
    return { ratePerHour: 0, coveredHours, sufficient: false };
  }
  return {
    ratePerHour: (index.prefix[last] - index.prefix[first]) / coveredHours,
    coveredHours,
    sufficient: true,
  };
}

/** Trailing burn rate at each sample inside [fromMs, toMs] (drain-rate chart). */
export function computeBurnSeries(
  index: BurnIndex,
  windowHours: number,
  fromMs: number,
  toMs: number
): SeriesPoint[] {
  const windowMs = windowHours * HOUR_MS;
  const minCoveredMs = windowMs * MIN_BURN_COVERAGE;
  const points: SeriesPoint[] = [];
  let first = 0;
  for (let i = lowerBound(index.times, fromMs - windowMs); i < index.times.length; i += 1) {
    const t = index.times[i];
    if (t > toMs) break;
    while (index.times[first] < t - windowMs) first += 1;
    const coveredMs = t - index.times[first];
    if (t < fromMs || coveredMs < minCoveredMs || coveredMs <= 0) continue;
    points.push({ t, value: ((index.prefix[i] - index.prefix[first]) * HOUR_MS) / coveredMs });
  }
  return points;
}

export interface RecordedSeries {
  pool: SeriesPoint[];
  perAccount: Record<string, SeriesPoint[]>;
  stepUps: StepUpEvent[];
}

/**
 * Pool remaining from history inside [fromMs, toMs]. One sample before `fromMs`
 * is kept so the line reaches the left edge. Each account carries its last
 * recorded window forward; before its first record it is back-filled with that
 * first record, and an account the file never mentions contributes its current
 * live remaining (`fallbackRemaining`) so the line stays on the pool's scale.
 */
export function buildRecordedSeries(
  samples: readonly HistorySample[],
  accounts: ReadonlyArray<{ id: string; fallbackRemaining: number }>,
  fromMs: number,
  toMs: number
): RecordedSeries {
  const ids = new Set(accounts.map((account) => account.id));
  const current = new Map<string, HistoryWindow>();
  for (const sample of samples) {
    for (const account of sample.accounts) {
      if (account.weekly && ids.has(account.id) && !current.has(account.id)) {
        current.set(account.id, account.weekly);
      }
    }
    if (current.size === ids.size) break;
  }

  const pool: SeriesPoint[] = [];
  const perAccount: Record<string, SeriesPoint[]> = {};
  accounts.forEach((account) => (perAccount[account.id] = []));
  const stepUps: StepUpEvent[] = [];
  const startIndex = Math.max(
    0,
    lowerBound(
      samples.map((sample) => sample.t),
      fromMs
    ) - 1
  );
  const previousRemaining = new Map<string, number>();

  samples.forEach((sample, index) => {
    for (const account of sample.accounts) {
      if (account.weekly && ids.has(account.id)) current.set(account.id, account.weekly);
    }
    if (index < startIndex || sample.t > toMs) return;

    let total = 0;
    let restored = 0;
    const restoredIds: string[] = [];
    for (const account of accounts) {
      const window = current.get(account.id);
      const remaining = window
        ? 100 - effectiveUsed(window, sample.t)
        : clampPercent(account.fallbackRemaining);
      const before = previousRemaining.get(account.id);
      if (before !== undefined && remaining - before >= 1) {
        restored += remaining - before;
        restoredIds.push(account.id);
      }
      previousRemaining.set(account.id, remaining);
      perAccount[account.id].push({ t: sample.t, value: remaining });
      total += remaining;
    }
    if (restored > 0) stepUps.push({ t: sample.t, amount: restored, accountIds: restoredIds });
    pool.push({ t: sample.t, value: total });
  });

  return { pool, perAccount, stepUps };
}

/* ------------------------------------------------------------------------ */
/* Forward simulation                                                       */
/* ------------------------------------------------------------------------ */

export interface SimulationAccount {
  id: string;
  /** 0..100 weekly used at `startMs`. */
  used: number;
  resetAtMs: number | null;
  periodMs: number;
}

export const GRANT_POLICIES = ['expiry', 'limit', 'off'] as const;
export type GrantPolicy = (typeof GRANT_POLICIES)[number];

/** A reset grant (Claude) or reset credit (Codex) the hub's scheduler may spend. */
export interface SimulationGrant {
  id: string;
  accountId: string;
  /** null: no known expiry, so the `expiry` policy never fires. */
  expiresAtMs: number | null;
  startsAtMs: number | null;
  policy: GrantPolicy;
  /** The `expiry` policy spends this long before the grant expires. */
  leadMs: number;
  /** Claude only accepts a reset while the account is at its limit. */
  requiresLimit: boolean;
  /** Resets left on the grant; each spend restores the account to 100. */
  left: number;
}

export type GrantOutcome =
  | { kind: 'spent'; atMs: number; amount: number }
  | {
      kind: 'unused';
      atMs: number | null;
      /** not_limited: due, but the account still had quota (Claude refuses). */
      reason: 'not_limited' | 'expired' | 'off' | 'not_reached';
    };

export interface SimulationOptions {
  startMs: number;
  endMs: number;
  /** Pool-wide demand in percentage points per hour (burn × future-usage factor). */
  burnPerHour: number;
  stepMs?: number;
  grants?: readonly SimulationGrant[];
}

export interface SimulationResult {
  pool: SeriesPoint[];
  perAccount: Record<string, SeriesPoint[]>;
  /** Weekly resets and grant spends, time-ordered. */
  stepUps: StepUpEvent[];
  /** When the whole pool first reaches 0, or null if not before `endMs`. */
  poolEmptyAtMs: number | null;
  /** The first single account to reach 0 (possibly already at `startMs`). */
  firstEmpty: { accountId: string; atMs: number } | null;
  /** First time each account reaches 0 at or after `startMs`; null if it never does. */
  emptyAt: Record<string, number | null>;
  /** The account demand drains first at `startMs` (soonest reset with quota left). */
  activeAccountId: string | null;
  /** The account drained after the active one. */
  nextAccountId: string | null;
  grantOutcomes: Record<string, GrantOutcome>;
}

interface SimState {
  id: string;
  order: number;
  remaining: number;
  resetAtMs: number | null;
  periodMs: number;
}

interface GrantState extends SimulationGrant {
  spent: number;
  /** An `expiry` grant that came due while its Claude account still had quota. */
  retrying: boolean;
  dueAtMs: number | null;
}

const bySoonestReset = (left: SimState, right: SimState) => {
  const leftAt = left.resetAtMs ?? Number.POSITIVE_INFINITY;
  const rightAt = right.resetAtMs ?? Number.POSITIVE_INFINITY;
  if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
  return left.order - right.order;
};

const grantActive = (grant: GrantState, atMs: number) =>
  grant.left > 0 &&
  (grant.startsAtMs === null || grant.startsAtMs <= atMs) &&
  (grant.expiresAtMs === null || atMs < grant.expiresAtMs);

export function simulatePool(
  accounts: readonly SimulationAccount[],
  options: SimulationOptions
): SimulationResult {
  const { startMs, endMs } = options;
  const stepMs = options.stepMs && options.stepMs > 0 ? options.stepMs : SIMULATION_STEP_MS;
  const ratePerMs = Math.max(0, options.burnPerHour) / HOUR_MS;
  const result: SimulationResult = {
    pool: [],
    perAccount: {},
    stepUps: [],
    poolEmptyAtMs: null,
    firstEmpty: null,
    emptyAt: {},
    activeAccountId: null,
    nextAccountId: null,
    grantOutcomes: {},
  };
  if (accounts.length === 0) return result;

  const state: SimState[] = accounts.map((account, order) => {
    const periodMs = account.periodMs > 0 ? account.periodMs : WEEK_MS;
    const entry: SimState = {
      id: account.id,
      order,
      remaining: 100 - clampPercent(account.used),
      resetAtMs: account.resetAtMs,
      periodMs,
    };
    // A reset at or before the start already happened: the window is fresh.
    while (entry.resetAtMs !== null && entry.resetAtMs <= startMs) {
      entry.remaining = 100;
      entry.resetAtMs += periodMs;
    }
    result.perAccount[account.id] = [];
    result.emptyAt[account.id] = null;
    return entry;
  });
  const byId = new Map(state.map((entry) => [entry.id, entry]));

  const grants: GrantState[] = (options.grants ?? [])
    .filter((grant) => byId.has(grant.accountId))
    .map((grant) => ({
      ...grant,
      spent: 0,
      retrying: false,
      dueAtMs:
        grant.policy === 'expiry' && grant.expiresAtMs !== null
          ? grant.expiresAtMs - Math.max(0, grant.leadMs)
          : null,
    }));
  for (const grant of grants) {
    if (grant.policy === 'off') {
      result.grantOutcomes[grant.id] = { kind: 'unused', atMs: null, reason: 'off' };
      grant.left = 0;
    } else if (grant.left <= 0 || (grant.expiresAtMs !== null && grant.expiresAtMs <= startMs)) {
      result.grantOutcomes[grant.id] = {
        kind: 'unused',
        atMs: grant.expiresAtMs,
        reason: 'expired',
      };
      grant.left = 0;
    }
  }

  const total = () => state.reduce((sum, entry) => sum + entry.remaining, 0);
  const emit = (t: number) => {
    result.pool.push({ t, value: total() });
    state.forEach((entry) => result.perAccount[entry.id].push({ t, value: entry.remaining }));
  };
  const checkPoolEmpty = (atMs: number) => {
    if (result.poolEmptyAtMs === null && state.every((entry) => entry.remaining <= EPSILON)) {
      result.poolEmptyAtMs = atMs;
    }
  };
  const markEmpty = (entry: SimState, atMs: number) => {
    if (result.emptyAt[entry.id] === null) result.emptyAt[entry.id] = atMs;
    if (!result.firstEmpty) result.firstEmpty = { accountId: entry.id, atMs };
  };

  /** Spend one reset from `grant` at `atMs`; false when it cannot be used then. */
  const spendGrant = (grant: GrantState, atMs: number): boolean => {
    const entry = byId.get(grant.accountId);
    if (!entry || !grantActive(grant, atMs)) return false;
    if (grant.requiresLimit && entry.remaining > EPSILON) return false;
    const amount = 100 - entry.remaining;
    emit(atMs);
    entry.remaining = 100;
    grant.left -= 1;
    grant.spent += 1;
    grant.retrying = false;
    if (grant.spent === 1) result.grantOutcomes[grant.id] = { kind: 'spent', atMs, amount };
    if (amount >= 0.5) {
      result.stepUps.push({
        t: atMs,
        amount,
        accountIds: [entry.id],
        kind: 'grant',
        grantId: grant.id,
      });
    }
    emit(atMs);
    return true;
  };

  /** Grants that fire when their account runs dry. */
  const onEmpty = (entry: SimState, atMs: number) => {
    for (const grant of grants) {
      if (grant.accountId !== entry.id || !grantActive(grant, atMs)) continue;
      const armed = grant.policy === 'limit' || (grant.policy === 'expiry' && grant.retrying);
      if (armed && spendGrant(grant, atMs)) return;
    }
  };

  const spend = (fromMs: number, toMs: number) => {
    if (toMs <= fromMs || ratePerMs <= 0) return;
    let demand = ratePerMs * (toMs - fromMs);
    let spent = 0;
    // Re-pick after each account runs dry: a grant may have just restored it.
    while (demand > EPSILON) {
      const entry = state.filter((item) => item.remaining > EPSILON).sort(bySoonestReset)[0];
      if (!entry) break;
      const take = Math.min(entry.remaining, demand);
      entry.remaining -= take;
      demand -= take;
      spent += take;
      if (entry.remaining <= EPSILON) {
        entry.remaining = 0;
        const atMs = Math.round(fromMs + spent / ratePerMs);
        markEmpty(entry, atMs);
        onEmpty(entry, atMs);
      }
    }
    checkPoolEmpty(Math.round(fromMs + spent / ratePerMs));
  };

  /** `expiry` grants due by `atMs`; one refused while the account has quota keeps waiting. */
  const fireDueGrants = (atMs: number) => {
    for (const grant of grants) {
      if (grant.dueAtMs === null || grant.dueAtMs > atMs) continue;
      if (grant.retrying || grant.spent > 0 || grant.left <= 0) continue;
      if (!spendGrant(grant, atMs)) grant.retrying = grantActive(grant, atMs);
    }
  };

  /** A waiting grant that reached its expiry unspent. */
  const expireWaiting = (atMs: number) => {
    for (const grant of grants) {
      if (!grant.retrying || grant.expiresAtMs === null || grant.expiresAtMs > atMs) continue;
      grant.retrying = false;
      grant.left = 0;
      result.grantOutcomes[grant.id] = {
        kind: 'unused',
        atMs: grant.dueAtMs,
        reason: 'not_limited',
      };
    }
  };

  emit(startMs);
  for (const entry of [...state].sort(bySoonestReset)) {
    if (entry.remaining > EPSILON) continue;
    markEmpty(entry, startMs);
    onEmpty(entry, startMs);
  }
  fireDueGrants(startMs);
  checkPoolEmpty(startMs);
  const drainOrder = state.filter((entry) => entry.remaining > EPSILON).sort(bySoonestReset);
  result.activeAccountId = drainOrder[0]?.id ?? null;
  result.nextAccountId = drainOrder[1]?.id ?? null;
  let t = startMs;
  while (t < endMs) {
    const stepEnd = Math.min(t + stepMs, endMs);
    let cursor = t;
    let emittedAt: number | null = null;
    for (;;) {
      let nextEvent = Number.POSITIVE_INFINITY;
      const consider = (at: number | null) => {
        if (at !== null && at > cursor && at <= stepEnd) nextEvent = Math.min(nextEvent, at);
      };
      state.forEach((entry) => consider(entry.resetAtMs));
      grants.forEach((grant) => {
        if (grant.retrying) consider(grant.expiresAtMs);
        else if (grant.spent === 0 && grant.left > 0) consider(grant.dueAtMs);
      });
      const hasEvent = Number.isFinite(nextEvent);
      spend(cursor, hasEvent ? nextEvent : stepEnd);
      if (!hasEvent) break;

      const at = nextEvent;
      const resetting = state.filter((entry) => entry.resetAtMs === at);
      if (resetting.length > 0) {
        emit(at);
        let amount = 0;
        for (const entry of resetting) {
          amount += 100 - entry.remaining;
          entry.remaining = 100;
          entry.resetAtMs = at + entry.periodMs;
        }
        result.stepUps.push({
          t: at,
          amount,
          accountIds: resetting.map((entry) => entry.id),
          kind: 'reset',
        });
        emit(at);
        emittedAt = at;
      }
      expireWaiting(at);
      fireDueGrants(at);
      cursor = at;
      if (cursor >= stepEnd) break;
    }
    if (emittedAt !== stepEnd) emit(stepEnd);
    t = stepEnd;
  }

  for (const grant of grants) {
    if (result.grantOutcomes[grant.id]) continue;
    if (grant.retrying) {
      result.grantOutcomes[grant.id] = {
        kind: 'unused',
        atMs: grant.dueAtMs,
        reason: 'not_limited',
      };
    } else if (grant.expiresAtMs !== null && grant.expiresAtMs <= endMs) {
      result.grantOutcomes[grant.id] = {
        kind: 'unused',
        atMs: grant.expiresAtMs,
        reason: 'expired',
      };
    } else {
      result.grantOutcomes[grant.id] = { kind: 'unused', atMs: null, reason: 'not_reached' };
    }
  }
  result.stepUps.sort((left, right) => left.t - right.t);

  return result;
}

/* ------------------------------------------------------------------------ */
/* Pool summary                                                             */
/* ------------------------------------------------------------------------ */

export interface PoolSummary {
  accountCount: number;
  capacity: number;
  remaining: number;
  poolEmptyAtMs: number | null;
  firstEmpty: { accountId: string; atMs: number } | null;
  /** First projected reset after now, with what it restores. */
  nextReset: StepUpEvent | null;
  horizonEndMs: number;
}

/** Stats look at least a week ahead even when the visible range ends sooner. */
export const projectionHorizonEnd = (rangeEndMs: number, nowMs: number) =>
  Math.max(rangeEndMs, nowMs + WEEK_MS);

export function summarizePool(
  accounts: readonly SimulationAccount[],
  simulation: SimulationResult,
  nowMs: number,
  horizonEndMs: number
): PoolSummary {
  const capacity = accounts.length * 100;
  const remaining = accounts.reduce((sum, account) => sum + 100 - clampPercent(account.used), 0);
  return {
    accountCount: accounts.length,
    capacity,
    remaining,
    poolEmptyAtMs: simulation.poolEmptyAtMs,
    firstEmpty: simulation.firstEmpty,
    nextReset:
      simulation.stepUps.find((event) => event.t > nowMs && event.kind !== 'grant') ?? null,
    horizonEndMs,
  };
}

/* ------------------------------------------------------------------------ */
/* Range and drawing helpers                                                */
/* ------------------------------------------------------------------------ */

export interface TimeRange {
  startMs: number;
  endMs: number;
}

/**
 * About a week back to a week ahead, aligned to local midnight. Each offset
 * step moves the window by one week. Calendar arithmetic keeps DST days intact.
 */
export function poolRange(nowMs: number, offsetWeeks = 0): TimeRange {
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 7 + offsetWeeks * 7);
  const end = new Date(today);
  end.setDate(end.getDate() + 8 + offsetWeeks * 7);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

/** Local midnights inside [startMs, endMs). */
export function dayTicks(range: TimeRange): number[] {
  const ticks: number[] = [];
  const cursor = new Date(range.startMs);
  cursor.setHours(0, 0, 0, 0);
  if (cursor.getTime() < range.startMs) cursor.setDate(cursor.getDate() + 1);
  while (cursor.getTime() < range.endMs) {
    ticks.push(cursor.getTime());
    cursor.setDate(cursor.getDate() + 1);
  }
  return ticks;
}

/**
 * Min/max bucketing for drawing: keeps spikes and vertical reset steps that
 * plain averaging would erase. Output is time-ordered and includes both ends.
 */
export function downsampleSeries(points: readonly SeriesPoint[], maxPoints: number): SeriesPoint[] {
  if (points.length <= maxPoints || maxPoints < 4) return [...points];
  const first = points[0];
  const last = points[points.length - 1];
  const buckets = Math.max(1, Math.floor((maxPoints - 2) / 2));
  const spanMs = Math.max(1, last.t - first.t);
  const output: SeriesPoint[] = [first];
  let index = 1;
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const bucketEnd = first.t + ((bucket + 1) / buckets) * spanMs;
    let min: SeriesPoint | null = null;
    let max: SeriesPoint | null = null;
    let minIndex = -1;
    let maxIndex = -1;
    for (; index < points.length - 1 && points[index].t <= bucketEnd; index += 1) {
      const point = points[index];
      if (!min || point.value < min.value) {
        min = point;
        minIndex = index;
      }
      if (!max || point.value > max.value) {
        max = point;
        maxIndex = index;
      }
    }
    if (!min || !max) continue;
    if (minIndex === maxIndex) output.push(min);
    else if (minIndex < maxIndex) output.push(min, max);
    else output.push(max, min);
  }
  output.push(last);
  return output;
}

/** Nearest point by time (binary search); null for an empty series. */
export function nearestPoint(points: readonly SeriesPoint[], t: number): SeriesPoint | null {
  if (points.length === 0) return null;
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  const index = lo;
  if (index <= 0) return points[0];
  if (index >= points.length) return points[points.length - 1];
  const before = points[index - 1];
  const after = points[index];
  return t - before.t <= after.t - t ? before : after;
}
