/**
 * Everything one provider's pool card draws, derived in one pure pass so the
 * card stays a layout component and the numbers are testable.
 */

import type { PoolAccount } from './accounts';
import { toSimulationAccounts } from './accounts';
import {
  buildBurnIndex,
  buildRecordedSeries,
  computeBurnRate,
  computeBurnSeries,
  downsampleSeries,
  FUTURE_USAGE_FACTORS,
  projectionHorizonEnd,
  simulatePool,
  summarizePool,
  type BurnRate,
  type FutureUsageMode,
  type PoolSummary,
  type TimeRange,
} from './poolModel';
import type { QuotaHistory, SeriesPoint, StepUpEvent } from './types';

export interface AccountSeries {
  key: string;
  recorded: SeriesPoint[];
  projected: SeriesPoint[];
}

export interface PoolView {
  /** Accounts with a known weekly window: the pool's members. */
  members: PoolAccount[];
  /** Accounts of this provider without weekly data; excluded from capacity. */
  missing: PoolAccount[];
  summary: PoolSummary;
  burn: BurnRate;
  /** burn × future-usage factor: the demand the projection assumes. */
  projectedBurnPerHour: number;
  hasHistory: boolean;
  remaining: {
    recorded: SeriesPoint[];
    projected: SeriesPoint[];
    recordedStepUps: StepUpEvent[];
    projectedStepUps: StepUpEvent[];
    accounts: AccountSeries[];
  };
  drain: {
    recorded: SeriesPoint[];
    projected: SeriesPoint[];
  };
}

export interface PoolViewInput {
  accounts: readonly PoolAccount[];
  history: QuotaHistory | null;
  nowMs: number;
  range: TimeRange;
  burnWindowHours: number;
  futureUsage: FutureUsageMode;
  /** Drawing budget per series; ~one point per horizontal pixel. */
  maxPoints?: number;
}

const within = (points: readonly SeriesPoint[], fromMs: number, toMs: number) => {
  // Keep one point either side so lines run to the plot edges.
  let first = points.findIndex((point) => point.t >= fromMs);
  if (first === -1) return [];
  first = Math.max(0, first - 1);
  let last = first;
  while (last < points.length - 1 && points[last].t <= toMs) last += 1;
  return points.slice(first, last + 1);
};

export function buildPoolView(input: PoolViewInput): PoolView {
  const { accounts, history, nowMs, range, burnWindowHours, futureUsage } = input;
  const maxPoints = input.maxPoints ?? 720;
  const members = accounts.filter((account) => account.quota.weekly !== null);
  const missing = accounts.filter((account) => account.quota.weekly === null);
  const simAccounts = toSimulationAccounts(members);
  const ids = new Set(simAccounts.map((account) => account.id));
  const samples = history?.samples ?? [];
  const hasHistory = samples.some((sample) =>
    sample.accounts.some((account) => ids.has(account.id) && account.weekly)
  );

  const burnIndex = buildBurnIndex(samples, ids);
  const burn = computeBurnRate(burnIndex, nowMs, burnWindowHours);
  const projectedBurnPerHour = burn.ratePerHour * FUTURE_USAGE_FACTORS[futureUsage];

  const horizonEndMs = projectionHorizonEnd(range.endMs, nowMs);
  const simulation = simulatePool(simAccounts, {
    startMs: nowMs,
    endMs: horizonEndMs,
    burnPerHour: projectedBurnPerHour,
  });
  const summary = summarizePool(simAccounts, simulation, nowMs, horizonEndMs);

  // Recorded: history inside the range up to now, then the live value at now.
  const liveByKey = new Map(simAccounts.map((account) => [account.id, 100 - account.used]));
  const recordedTo = Math.min(nowMs - 1, range.endMs);
  const recorded =
    range.startMs < nowMs
      ? buildRecordedSeries(
          samples,
          simAccounts.map((account) => ({
            id: account.id,
            fallbackRemaining: 100 - account.used,
          })),
          range.startMs,
          recordedTo
        )
      : { pool: [], perAccount: {} as Record<string, SeriesPoint[]>, stepUps: [] };
  const nowVisible = nowMs >= range.startMs && nowMs <= range.endMs;
  const recordedPool = nowVisible
    ? [...recorded.pool, { t: nowMs, value: summary.remaining }]
    : recorded.pool;

  const projectedPool =
    nowMs < range.endMs ? within(simulation.pool, range.startMs, range.endMs) : [];

  const accountSeries: AccountSeries[] = simAccounts.map((account) => {
    const past = recorded.perAccount[account.id] ?? [];
    const live = liveByKey.get(account.id) ?? 0;
    return {
      key: account.id,
      recorded: downsampleSeries(
        nowVisible ? [...past, { t: nowMs, value: live }] : past,
        maxPoints
      ),
      projected:
        nowMs < range.endMs
          ? downsampleSeries(
              within(simulation.perAccount[account.id] ?? [], range.startMs, range.endMs),
              maxPoints
            )
          : [],
    };
  });

  const inRange = (event: StepUpEvent) => event.t >= range.startMs && event.t <= range.endMs;

  const drainRecorded =
    range.startMs < nowMs
      ? computeBurnSeries(burnIndex, burnWindowHours, range.startMs, Math.min(nowMs, range.endMs))
      : [];
  const drainProjected =
    nowMs < range.endMs
      ? [
          { t: Math.max(nowMs, range.startMs), value: projectedBurnPerHour },
          { t: range.endMs, value: projectedBurnPerHour },
        ]
      : [];

  return {
    members,
    missing,
    summary,
    burn,
    projectedBurnPerHour,
    hasHistory,
    remaining: {
      recorded: downsampleSeries(recordedPool, maxPoints),
      projected: downsampleSeries(projectedPool, maxPoints),
      recordedStepUps: recorded.stepUps.filter(inRange),
      projectedStepUps: simulation.stepUps.filter(inRange),
      accounts: accountSeries,
    },
    drain: {
      recorded: downsampleSeries(drainRecorded, maxPoints),
      projected: drainProjected,
    },
  };
}

/** Round an axis maximum up to 1, 2, 2.5 or 5 × 10^n. */
export function niceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * base + 1e-9) return step * base;
  }
  return 10 * base;
}
