import { describe, expect, test } from 'bun:test';
import {
  buildBurnIndex,
  buildRecordedSeries,
  computeBurnRate,
  computeBurnSeries,
  downsampleSeries,
  nearestPoint,
  pickReading,
  poolRange,
  resolveAccountQuota,
  rollWindow,
  simulatePool,
  summarizePool,
  type SimulationGrant,
} from '@/features/quota/pool/poolModel';
import { buildPoolView, niceCeiling } from '@/features/quota/pool/poolView';
import { WEEK_MS } from '@/features/quota/pool/signals';
import {
  FABLE_WEEKLY_SHARE,
  scopeCapacity,
  scopeLeft,
  type HistorySample,
  type QuotaReading,
} from '@/features/quota/pool/types';
import type { PoolAccount } from '@/features/quota/pool/accounts';
import { resetGrantEffect, type ResetGrant } from '@/services/api/quotaResets';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 26, 12);

const sample = (t: number, weekly: Record<string, number | null>): HistorySample => ({
  t,
  accounts: Object.entries(weekly).map(([id, used]) => ({
    id,
    provider: 'claude',
    on: true,
    weekly: used === null ? null : { used, resetAtMs: null },
    fiveHour: null,
    seenMs: t,
  })),
});

const reading = (
  source: QuotaReading['source'],
  observedAtMs: number | null,
  used: number,
  resetAtMs: number | null = NOW + DAY
): QuotaReading => ({
  source,
  observedAtMs,
  weekly: { used, resetAtMs, periodMs: WEEK_MS },
  fiveHour: null,
});

describe('current account state', () => {
  test('prefers the fresher live reading, seat-pacer on ties, history only as fallback', () => {
    const pacer = reading('seat-pacer', NOW - 60_000, 45);
    const signals = reading('signals', NOW - 2 * HOUR, 40);
    const history = reading('history', NOW - 5 * 60_000, 44);
    expect(pickReading([signals, pacer, history], 'weekly')).toBe(pacer);
    // Signals newer than the plugin snapshot win.
    const freshSignals = reading('signals', NOW, 46);
    expect(pickReading([pacer, freshSignals], 'weekly')).toBe(freshSignals);
    // Equal observation time: seat-pacer.
    const tieSignals = reading('signals', NOW - 60_000, 41);
    expect(pickReading([tieSignals, pacer], 'weekly')).toBe(pacer);
    // History is used only when no live source reports the window.
    expect(pickReading([history], 'weekly')).toBe(history);
    expect(pickReading([], 'weekly')).toBeNull();
  });

  test('an account already past its reset reads as a fresh window', () => {
    const passed = NOW - HOUR;
    const resolved = resolveAccountQuota([reading('signals', NOW - 9 * DAY, 80, passed)], NOW);
    expect(resolved.weekly).toEqual({
      used: 0,
      resetAtMs: passed + WEEK_MS,
      periodMs: WEEK_MS,
      rolled: true,
    });
    // Several periods behind: rolls forward by whole periods past now.
    const longAgo = NOW - 15 * DAY;
    const rolled = rollWindow({ used: 50, resetAtMs: longAgo, periodMs: WEEK_MS }, NOW);
    expect(rolled.resetAtMs).toBe(longAgo + 3 * WEEK_MS);
    expect(rolled.resetAtMs! > NOW).toBe(true);
    // A reset exactly at now has happened.
    expect(rollWindow({ used: 50, resetAtMs: NOW, periodMs: WEEK_MS }, NOW).used).toBe(0);
  });
});

describe('burn rate', () => {
  test('sums positive increases, ignores reset drops, divides by covered hours', () => {
    const samples = [
      sample(NOW - 3 * HOUR, { a: 10, b: 50 }),
      sample(NOW - 2 * HOUR, { a: 20, b: 55 }),
      sample(NOW - HOUR, { a: 5, b: 60 }), // a reset: -15 is ignored
      sample(NOW, { a: 15, b: 60 }),
    ];
    const index = buildBurnIndex(samples, new Set(['a', 'b']));
    // a: +10 +10, b: +5 +5 => 30 over 3 h.
    expect(computeBurnRate(index, NOW, 3)).toEqual({
      ratePerHour: 10,
      coveredHours: 3,
      sufficient: true,
    });
    // Only accounts in the pool count.
    const onlyB = buildBurnIndex(samples, new Set(['b']));
    expect(computeBurnRate(onlyB, NOW, 3).ratePerHour).toBeCloseTo(10 / 3, 9);
  });

  test('bridges a sample where an account is missing instead of reading it as a reset', () => {
    const samples = [
      sample(NOW - 2 * HOUR, { a: 10 }),
      sample(NOW - HOUR, { a: null }),
      sample(NOW, { a: 16 }),
    ];
    const index = buildBurnIndex(samples, new Set(['a']));
    expect(computeBurnRate(index, NOW, 3).ratePerHour).toBe(3);
  });

  test('a recorded window whose reset passed counts from zero', () => {
    const samples: HistorySample[] = [
      {
        t: NOW - 2 * HOUR,
        accounts: [
          {
            id: 'a',
            provider: 'claude',
            on: true,
            weekly: { used: 70, resetAtMs: NOW - 90 * 60_000 },
            fiveHour: null,
            seenMs: null,
          },
        ],
      },
      {
        t: NOW - HOUR,
        accounts: [
          {
            id: 'a',
            provider: 'claude',
            on: true,
            weekly: { used: 70, resetAtMs: NOW - 90 * 60_000 },
            fiveHour: null,
            seenMs: null,
          },
        ],
      },
      sample(NOW, { a: 4 }),
    ];
    const index = buildBurnIndex(samples, new Set(['a']));
    // 70 (stale, read as 0 after its reset) -> 4: +4, not -66.
    expect(computeBurnRate(index, NOW, 3)).toMatchObject({ ratePerHour: 2, sufficient: true });
  });

  test('falls back to 0 with too little history', () => {
    const empty = buildBurnIndex([], new Set(['a']));
    expect(computeBurnRate(empty, NOW, 3)).toEqual({
      ratePerHour: 0,
      coveredHours: 0,
      sufficient: false,
    });
    const single = buildBurnIndex([sample(NOW - HOUR, { a: 10 })], new Set(['a']));
    expect(computeBurnRate(single, NOW, 3).sufficient).toBe(false);
    // Two samples 30 minutes apart do not cover half of a 3-hour window.
    const short = buildBurnIndex(
      [sample(NOW - 30 * 60_000, { a: 10 }), sample(NOW, { a: 20 })],
      new Set(['a'])
    );
    expect(computeBurnRate(short, NOW, 3)).toMatchObject({ ratePerHour: 0, sufficient: false });
    // ...but they do cover half of a 1-hour window.
    expect(computeBurnRate(short, NOW, 1)).toMatchObject({ ratePerHour: 20, sufficient: true });
    // Stale history: nothing inside the window ending now.
    const stale = buildBurnIndex(
      [sample(NOW - 30 * HOUR, { a: 10 }), sample(NOW - 27 * HOUR, { a: 20 })],
      new Set(['a'])
    );
    expect(computeBurnRate(stale, NOW, 6).sufficient).toBe(false);
  });

  test('drain series reports the trailing rate per sample', () => {
    const samples = Array.from({ length: 13 }, (_, i) =>
      sample(NOW - (12 - i) * HOUR, { a: i * 2 })
    );
    const index = buildBurnIndex(samples, new Set(['a']));
    const series = computeBurnSeries(index, 3, NOW - 6 * HOUR, NOW);
    expect(series.length).toBe(7);
    expect(series.every((point) => point.value === 2)).toBe(true);
  });
});

describe('forward simulation', () => {
  test('drains the soonest-reset account first and overflows within a step', () => {
    const result = simulatePool(
      [
        { id: 'late', used: 0, resetAtMs: NOW + 20 * HOUR, periodMs: WEEK_MS },
        { id: 'soon', used: 95, resetAtMs: NOW + 10 * HOUR, periodMs: WEEK_MS },
      ],
      { startMs: NOW, endMs: NOW + HOUR, burnPerHour: 40 }
    );
    // Step 1 demands 10: 5 from "soon" (now empty) and 5 overflowing to "late".
    expect(result.perAccount.soon[1]).toEqual({ t: NOW + 15 * 60_000, value: 0 });
    expect(result.perAccount.late[1]).toEqual({ t: NOW + 15 * 60_000, value: 95 });
    expect(result.firstEmpty).toEqual({ accountId: 'soon', atMs: NOW + 7.5 * 60_000 });
    expect(result.pool.map((point) => point.value)).toEqual([105, 95, 85, 75, 65]);
  });

  test('a reset restores the account at its exact time and records the step-up', () => {
    const resetAt = NOW + 50 * 60_000; // inside the 4th 15-minute step
    const result = simulatePool(
      [
        { id: 'a', used: 90, resetAtMs: resetAt, periodMs: WEEK_MS },
        { id: 'b', used: 0, resetAtMs: NOW + 3 * DAY, periodMs: WEEK_MS },
      ],
      { startMs: NOW, endMs: NOW + 2 * HOUR, burnPerHour: 12 }
    );
    // "a" empties after 50 minutes of 12%/h... exactly as it resets.
    expect(result.firstEmpty).toEqual({ accountId: 'a', atMs: resetAt });
    expect(result.stepUps).toEqual([{ t: resetAt, amount: 100, accountIds: ['a'], kind: 'reset' }]);
    const atReset = result.pool.filter((point) => point.t === resetAt);
    expect(atReset.map((point) => point.value)).toEqual([100, 200]);
    // After the reset "a" moves to the back of the queue: "b" (reset in 3 days) drains next.
    const lastA = result.perAccount.a[result.perAccount.a.length - 1];
    const lastB = result.perAccount.b[result.perAccount.b.length - 1];
    expect(lastA.value).toBe(100);
    expect(lastB.value).toBeCloseTo(100 - 12 * (70 / 60), 9);
  });

  test('accounts resetting together form one step-up with the summed amount', () => {
    const resetAt = NOW + HOUR;
    const result = simulatePool(
      [
        { id: 'a', used: 30, resetAtMs: resetAt, periodMs: WEEK_MS },
        { id: 'b', used: 60, resetAtMs: resetAt, periodMs: WEEK_MS },
      ],
      { startMs: NOW, endMs: NOW + 2 * HOUR, burnPerHour: 0 }
    );
    expect(result.stepUps).toEqual([
      { t: resetAt, amount: 90, accountIds: ['a', 'b'], kind: 'reset' },
    ]);
  });

  test('reports when the first account and then the whole pool run out', () => {
    const accounts = [
      { id: 'a', used: 90, resetAtMs: NOW + 8 * DAY, periodMs: WEEK_MS },
      { id: 'b', used: 80, resetAtMs: NOW + 9 * DAY, periodMs: WEEK_MS },
    ];
    const result = simulatePool(accounts, { startMs: NOW, endMs: NOW + 6 * HOUR, burnPerHour: 10 });
    expect(result.firstEmpty).toEqual({ accountId: 'a', atMs: NOW + HOUR });
    expect(result.poolEmptyAtMs).toBe(NOW + 3 * HOUR);
    expect(result.pool[result.pool.length - 1].value).toBe(0);

    const summary = summarizePool(accounts, result, NOW, NOW + 6 * HOUR);
    expect(summary).toMatchObject({ accountCount: 2, capacity: 200, remaining: 30 });
    expect(summary.poolEmptyAtMs).toBe(NOW + 3 * HOUR);
  });

  test('never empties without burn, and an exhausted account is first empty immediately', () => {
    const result = simulatePool(
      [
        { id: 'full', used: 0, resetAtMs: NOW + 2 * DAY, periodMs: WEEK_MS },
        { id: 'spent', used: 100, resetAtMs: NOW + DAY, periodMs: WEEK_MS },
      ],
      { startMs: NOW, endMs: NOW + 3 * DAY, burnPerHour: 0 }
    );
    expect(result.poolEmptyAtMs).toBeNull();
    expect(result.firstEmpty).toEqual({ accountId: 'spent', atMs: NOW });
    expect(result.stepUps.map((event) => [event.t, event.amount])).toEqual([
      [NOW + DAY, 100],
      [NOW + 2 * DAY, 0],
    ]);
  });

  test('a reset at or before the start is already applied', () => {
    const result = simulatePool([{ id: 'a', used: 70, resetAtMs: NOW - HOUR, periodMs: WEEK_MS }], {
      startMs: NOW,
      endMs: NOW + HOUR,
      burnPerHour: 0,
    });
    expect(result.pool[0].value).toBe(100);
    expect(result.stepUps).toEqual([]);
  });
});

describe('pool view', () => {
  const account = (
    key: string,
    used: number | null,
    resetAtMs: number = NOW + 2 * DAY
  ): PoolAccount => ({
    key,
    authIndex: key,
    provider: 'claude',
    file: { name: `${key}.json`, provider: 'claude', authIndex: key },
    quota: {
      weekly: used === null ? null : { used, resetAtMs, periodMs: WEEK_MS, rolled: false },
      fiveHour: null,
      source: used === null ? null : 'signals',
      observedAtMs: NOW,
    },
    status: { kind: used === null ? 'no_data' : 'available', untilMs: null },
  });

  test('without history: no burn, a flat projection with step-ups, and no pool-empty time', () => {
    const view = buildPoolView({
      accounts: [account('a', 40), account('b', 10, NOW + 5 * DAY), account('c', null)],
      history: null,
      nowMs: NOW,
      range: poolRange(NOW),
      burnWindowHours: 3,
      futureUsage: 'same',
    });
    expect(view.hasHistory).toBe(false);
    expect(view.burn).toEqual({ ratePerHour: 0, coveredHours: 0, sufficient: false });
    expect(view.members.map((member) => member.key)).toEqual(['a', 'b']);
    expect(view.missing.map((member) => member.key)).toEqual(['c']);
    expect(view.summary).toMatchObject({ capacity: 200, remaining: 150, poolEmptyAtMs: null });
    expect(view.summary.nextReset).toEqual({
      t: NOW + 2 * DAY,
      amount: 40,
      accountIds: ['a'],
      kind: 'reset',
    });
    expect(view.remaining.recorded).toEqual([{ t: NOW, value: 150 }]);
    expect(view.remaining.projected[0]).toEqual({ t: NOW, value: 150 });
    expect(view.drain.projected.every((point) => point.value === 0)).toBe(true);
  });

  test('future usage scales the projected burn', () => {
    const history = {
      intervalMs: HOUR,
      updatedMs: NOW,
      samples: [0, 1, 2, 3].map((i) => sample(NOW - (3 - i) * HOUR, { a: 10 + i * 3 })),
    };
    const base = {
      accounts: [account('a', 19)],
      history,
      nowMs: NOW,
      range: poolRange(NOW),
      burnWindowHours: 3,
    };
    expect(buildPoolView({ ...base, futureUsage: 'same' }).projectedBurnPerHour).toBe(3);
    expect(buildPoolView({ ...base, futureUsage: 'double' }).projectedBurnPerHour).toBe(6);
    expect(buildPoolView({ ...base, futureUsage: 'half' }).projectedBurnPerHour).toBe(1.5);
    expect(buildPoolView({ ...base, futureUsage: 'none' }).projectedBurnPerHour).toBe(0);
    expect(buildPoolView({ ...base, futureUsage: 'same' }).burn.ratePerHour).toBe(3);
  });

  test('recorded series annotates reset jumps and ends at the live value', () => {
    const samples = [
      sample(NOW - 3 * HOUR, { a: 90 }),
      sample(NOW - 2 * HOUR, { a: 95 }),
      sample(NOW - HOUR, { a: 2 }),
    ];
    const recorded = buildRecordedSeries(
      samples,
      [
        { id: 'a', fallbackRemaining: 0 },
        { id: 'never-recorded', fallbackRemaining: 60 },
      ],
      NOW - 4 * HOUR,
      NOW
    );
    expect(recorded.pool.map((point) => point.value)).toEqual([70, 65, 158]);
    expect(recorded.stepUps).toEqual([{ t: NOW - HOUR, amount: 93, accountIds: ['a'] }]);
  });
});

describe('drawing helpers', () => {
  test('downsampling keeps both ends, spikes and vertical steps within budget', () => {
    const points = Array.from({ length: 4000 }, (_, i) => ({
      t: NOW + i * 300_000,
      value: i === 1234 ? 999 : i < 2000 ? 100 : 400,
    }));
    const reduced = downsampleSeries(points, 400);
    expect(reduced.length).toBeLessThanOrEqual(400);
    expect(reduced[0]).toBe(points[0]);
    expect(reduced[reduced.length - 1]).toBe(points[points.length - 1]);
    expect(reduced.some((point) => point.value === 999)).toBe(true);
    expect(reduced.some((point) => point.value === 100)).toBe(true);
    expect(reduced.some((point) => point.value === 400)).toBe(true);
    for (let i = 1; i < reduced.length; i += 1) {
      expect(reduced[i].t).toBeGreaterThanOrEqual(reduced[i - 1].t);
    }
    expect(downsampleSeries(points.slice(0, 10), 400)).toEqual(points.slice(0, 10));
  });

  test('nearest point and range helpers', () => {
    const points = [
      { t: 0, value: 1 },
      { t: 10, value: 2 },
      { t: 30, value: 3 },
    ];
    expect(nearestPoint(points, 4)).toBe(points[0]);
    expect(nearestPoint(points, 21)).toBe(points[2]);
    expect(nearestPoint(points, 99)).toBe(points[2]);
    expect(nearestPoint([], 1)).toBeNull();

    const range = poolRange(NOW);
    expect(range.startMs).toBeLessThan(NOW - 6 * DAY);
    expect(range.endMs).toBeGreaterThan(NOW + 7 * DAY);
    const next = poolRange(NOW, 1);
    expect(Math.round((next.startMs - range.startMs) / DAY)).toBe(7);
    expect(niceCeiling(3.7)).toBe(5);
    expect(niceCeiling(12)).toBe(20);
    expect(niceCeiling(0)).toBe(1);
  });
});

describe('reset grants in the projection', () => {
  const accounts = [
    { id: 'a', used: 100, resetAtMs: NOW + 3 * DAY, periodMs: WEEK_MS },
    { id: 'b', used: 50, resetAtMs: NOW + 4 * DAY, periodMs: WEEK_MS },
  ];
  const grant = (overrides: Partial<SimulationGrant>): SimulationGrant => ({
    id: 'g',
    accountId: 'a',
    expiresAtMs: NOW + 6 * HOUR,
    startsAtMs: null,
    policy: 'expiry',
    leadMs: 10 * 60_000,
    requiresLimit: true,
    left: 1,
    ...overrides,
  });
  const run = (grants: SimulationGrant[], burnPerHour = 0) =>
    simulatePool(accounts, { startMs: NOW, endMs: NOW + 2 * DAY, burnPerHour, grants });

  test('expiry policy spends the lead time before expiry on a limited account', () => {
    const result = run([grant({})]);
    const at = NOW + 6 * HOUR - 10 * 60_000;
    expect(result.grantOutcomes.g).toEqual({ kind: 'spent', atMs: at, amount: 100 });
    expect(result.stepUps).toContainEqual({
      t: at,
      amount: 100,
      accountIds: ['a'],
      kind: 'grant',
      grantId: 'g',
    });
    const atSpend = result.pool.filter((point) => point.t === at).map((point) => point.value);
    expect(atSpend).toEqual([50, 150]);
  });

  test('Claude refuses while the account has quota; Codex refills what was used', () => {
    const refused = run([grant({ accountId: 'b' })]);
    expect(refused.grantOutcomes.g).toEqual({
      kind: 'unused',
      atMs: NOW + 6 * HOUR - 10 * 60_000,
      reason: 'not_limited',
    });
    expect(refused.stepUps.filter((event) => event.kind === 'grant')).toHaveLength(0);
    const codex = run([grant({ accountId: 'b', requiresLimit: false })]);
    expect(codex.grantOutcomes.g).toMatchObject({ kind: 'spent', amount: 50 });
  });

  test('a refused expiry grant is spent if the account runs dry before it expires', () => {
    // Without demand b keeps quota: refused at the due time, never spent.
    const result = simulatePool(
      [{ id: 'b', used: 50, resetAtMs: NOW + 4 * DAY, periodMs: WEEK_MS }],
      {
        startMs: NOW + 6 * HOUR - 20 * 60_000,
        endMs: NOW + DAY,
        burnPerHour: 0,
        grants: [grant({ accountId: 'b' })],
      }
    );
    expect(result.grantOutcomes.g).toMatchObject({ kind: 'unused', reason: 'not_limited' });
    const draining = simulatePool(
      [{ id: 'b', used: 92, resetAtMs: NOW + 4 * DAY, periodMs: WEEK_MS }],
      {
        startMs: NOW + 6 * HOUR - 20 * 60_000,
        endMs: NOW + DAY,
        burnPerHour: 32,
        grants: [grant({ accountId: 'b' })],
      }
    );
    // 8% at 32%/h runs dry 15 minutes in: 5 minutes after the refused attempt.
    expect(draining.grantOutcomes.g).toEqual({
      kind: 'spent',
      atMs: NOW + 6 * HOUR - 5 * 60_000,
      amount: 100,
    });
  });

  test('limit policy spends when the account runs dry; off never spends', () => {
    // a is already empty, so b serves and runs dry after 10 h at 5%/h.
    const result = run([grant({ accountId: 'b', policy: 'limit', expiresAtMs: NOW + DAY })], 5);
    expect(result.emptyAt.b).toBe(NOW + 10 * HOUR);
    expect(result.grantOutcomes.g).toEqual({ kind: 'spent', atMs: NOW + 10 * HOUR, amount: 100 });
    const off = run([grant({ policy: 'off' })]);
    expect(off.grantOutcomes.g).toEqual({ kind: 'unused', atMs: null, reason: 'off' });
    expect(off.stepUps.filter((event) => event.kind === 'grant')).toHaveLength(0);
  });

  test('an account restored mid-step keeps draining in that step', () => {
    const result = simulatePool(
      [{ id: 'a', used: 90, resetAtMs: NOW + 4 * DAY, periodMs: WEEK_MS }],
      {
        startMs: NOW,
        endMs: NOW + 15 * 60_000,
        burnPerHour: 100,
        grants: [grant({ policy: 'limit', expiresAtMs: NOW + DAY })],
      }
    );
    // 10% lasts 6 minutes; the grant refills it and the last 9 minutes drain 15%.
    expect(result.grantOutcomes.g).toEqual({ kind: 'spent', atMs: NOW + 6 * 60_000, amount: 100 });
    expect(result.pool[result.pool.length - 1]).toEqual({ t: NOW + 15 * 60_000, value: 85 });
  });

  test('a grant that only becomes usable later is re-checked when it does', () => {
    // Due at +50 min, expiring at +60 min, usable from +55 min (e.g. an off credit expires).
    const due = run([
      grant({
        requiresLimit: false,
        expiresAtMs: NOW + HOUR,
        startsAtMs: NOW + 55 * 60_000,
      }),
    ]);
    expect(due.grantOutcomes.g).toEqual({ kind: 'spent', atMs: NOW + 55 * 60_000, amount: 100 });
    // A limit grant on the already-dry account resumes when it becomes usable.
    const limit = run([
      grant({ policy: 'limit', expiresAtMs: NOW + DAY, startsAtMs: NOW + 55 * 60_000 }),
    ]);
    expect(limit.grantOutcomes.g).toEqual({
      kind: 'spent',
      atMs: NOW + 55 * 60_000,
      amount: 100,
    });
  });

  test('a limit grant on an account that is already dry is spent at once', () => {
    const result = run([grant({ policy: 'limit' })]);
    expect(result.grantOutcomes.g).toEqual({ kind: 'spent', atMs: NOW, amount: 100 });
  });

  test('a limit grant that never sees the limit expires unused', () => {
    const result = run(
      [grant({ accountId: 'b', policy: 'limit', expiresAtMs: NOW + 5 * HOUR })],
      1
    );
    expect(result.grantOutcomes.g).toEqual({
      kind: 'unused',
      atMs: NOW + 5 * HOUR,
      reason: 'expired',
    });
  });

  test('reports who serves now, who is next, and when each runs dry', () => {
    const result = simulatePool(
      [
        { id: 'a', used: 0, resetAtMs: NOW + 5 * DAY, periodMs: WEEK_MS },
        { id: 'b', used: 90, resetAtMs: NOW + DAY, periodMs: WEEK_MS },
        { id: 'c', used: 100, resetAtMs: NOW + 2 * DAY, periodMs: WEEK_MS },
      ],
      { startMs: NOW, endMs: NOW + 12 * HOUR, burnPerHour: 2 }
    );
    expect(result.activeAccountId).toBe('b');
    expect(result.nextAccountId).toBe('a');
    expect(result.emptyAt).toEqual({ a: null, b: NOW + 5 * HOUR, c: NOW });
  });
});

describe('Fable scope', () => {
  /** One sample carrying `[weekly used, Fable meter]` per account; null leaves a window out. */
  const both = (
    t: number,
    used: Record<string, [number | null, number | null]>
  ): HistorySample => ({
    t,
    accounts: Object.entries(used).map(([id, [weekly, fable]]) => ({
      id,
      provider: 'claude',
      on: true,
      weekly: weekly === null ? null : { used: weekly, resetAtMs: null },
      fiveHour: null,
      fable: fable === null ? null : { used: fable, resetAtMs: null },
      seenMs: t,
    })),
  });

  test('the Fable window is resolved on its own, whichever source reports the weekly one', () => {
    const pacer: QuotaReading = {
      ...reading('seat-pacer', NOW - 10 * 60_000, 45),
      fable: { used: 60, resetAtMs: NOW + DAY, periodMs: WEEK_MS },
    };
    // Fresher than the plugin snapshot, but these headers carry no Fable window.
    const signals = reading('signals', NOW, 46);
    expect(pickReading([pacer, signals], 'weekly')).toBe(signals);
    expect(pickReading([pacer, signals], 'fable')).toBe(pacer);

    const resolved = resolveAccountQuota([pacer, signals], NOW);
    expect(resolved.weekly?.used).toBe(46);
    expect(resolved.fable).toEqual({
      used: 60,
      resetAtMs: NOW + DAY,
      periodMs: WEEK_MS,
      rolled: false,
    });
    expect(resolveAccountQuota([signals], NOW).fable).toBeNull();
    // A Fable window whose reset passed reads as fresh, like any other.
    const passed: QuotaReading = {
      ...reading('signals', NOW - 2 * DAY, 30),
      fable: { used: 90, resetAtMs: NOW - HOUR, periodMs: WEEK_MS },
    };
    expect(resolveAccountQuota([passed], NOW).fable).toMatchObject({ used: 0, rolled: true });
  });

  test('one unit for both scopes: Fable is half the weekly limit, capped by what weekly has left', () => {
    expect(FABLE_WEEKLY_SHARE).toBe(0.5);
    expect([scopeCapacity('all'), scopeCapacity('fable')]).toEqual([100, 50]);
    // The Fable meter at 56% leaves 44% of the allowance: 22% of the weekly limit.
    expect(scopeLeft('fable', 56, null)).toBe(22);
    // The weekly limit binds when it has less than that left, and never adds any.
    expect(scopeLeft('fable', 42, 4)).toBe(4);
    expect(scopeLeft('fable', 56, 90)).toBe(22);
    expect(scopeLeft('fable', 29, 0)).toBe(0);
    // A fresh account can put half its weekly limit into Fable, no more.
    expect(scopeLeft('fable', 0, 100)).toBe(50);
    expect(scopeLeft('all', 78, null)).toBe(22);
  });

  test('Fable burn is counted in weekly points and needs samples that record it', () => {
    const samples = [
      both(NOW - 3 * HOUR, { a: [10, 2] }),
      both(NOW - 2 * HOUR, { a: [20, 4] }),
      both(NOW - HOUR, { a: [30, 6] }),
      both(NOW, { a: [40, 8] }),
    ];
    const ids = new Set(['a']);
    expect(computeBurnRate(buildBurnIndex(samples, ids), NOW, 3).ratePerHour).toBe(10);
    // The meter climbs 2 points an hour: 1% of the weekly limit an hour.
    expect(computeBurnRate(buildBurnIndex(samples, ids, 'fable'), NOW, 3).ratePerHour).toBe(1);
    // Weekly-only samples (an older recorder) give the Fable scope nothing to measure.
    const weeklyOnly = samples.map((item) => sample(item.t, { a: item.accounts[0].weekly!.used }));
    expect(computeBurnRate(buildBurnIndex(weeklyOnly, ids, 'fable'), NOW, 3).ratePerHour).toBe(0);
  });

  test('burn coverage starts where the scope was first recorded', () => {
    // Three hours of weekly samples; Fable only in the last hour, its meter +2 an hour.
    const samples = [
      both(NOW - 3 * HOUR, { a: [10, null] }),
      both(NOW - 2 * HOUR, { a: [20, null] }),
      both(NOW - HOUR, { a: [30, 6] }),
      both(NOW - HOUR / 2, { a: [35, 7] }),
      both(NOW, { a: [40, 8] }),
    ];
    const index = buildBurnIndex(samples, new Set(['a']), 'fable');
    expect(index.recordedFromMs).toBe(NOW - HOUR);
    // One recorded hour is not half of a 3-hour window: no rate, rather than a
    // measured-looking 0 or one diluted over hours that recorded nothing.
    expect(computeBurnRate(index, NOW, 3)).toEqual({
      ratePerHour: 0,
      coveredHours: 1,
      sufficient: false,
    });
    expect(computeBurnRate(index, NOW, 1)).toEqual({
      ratePerHour: 1,
      coveredHours: 1,
      sufficient: true,
    });
    // The drain chart draws nothing before there is recorded coverage.
    expect(computeBurnSeries(index, 1, NOW - 3 * HOUR, NOW)).toEqual([
      { t: NOW - HOUR / 2, value: 1 },
      { t: NOW, value: 1 },
    ]);
    // A scope nobody recorded has no burn at all.
    const none = buildBurnIndex(samples.slice(0, 2), new Set(['a']), 'fable');
    expect(none.recordedFromMs).toBeNull();
    expect(computeBurnRate(none, NOW - 2 * HOUR, 1).sufficient).toBe(false);
    expect(computeBurnSeries(none, 1, NOW - 3 * HOUR, NOW)).toEqual([]);
    // The weekly scope of the same samples is measured over all three hours.
    expect(computeBurnRate(buildBurnIndex(samples, new Set(['a'])), NOW, 3).ratePerHour).toBe(10);
  });

  test('the recorded line is in weekly points, capped by recorded weekly quota', () => {
    const samples = [
      both(NOW - 5 * HOUR, { a: [10, null] }),
      both(NOW - 4 * HOUR, { a: [12, null] }),
      both(NOW - 3 * HOUR, { a: [14, 30] }), // 70% of the allowance = 35; weekly has 86 left
      both(NOW - 2 * HOUR, { a: [16, 35] }), // 32.5
      both(NOW - HOUR, { a: [90, 40] }), // allowance 30, but only 10 of weekly left
    ];
    const fable = buildRecordedSeries(
      samples,
      [
        { id: 'a', fallbackRemaining: 10 },
        { id: 'never-recorded', fallbackRemaining: 20 },
      ],
      NOW - 6 * HOUR,
      NOW,
      'fable'
    );
    // Starts at the first Fable sample: no back-filled line across the hours before.
    expect(fable.pool).toEqual([
      { t: NOW - 3 * HOUR, value: 35 + 20 },
      { t: NOW - 2 * HOUR, value: 32.5 + 20 },
      { t: NOW - HOUR, value: 10 + 20 },
    ]);
    expect(fable.perAccount.a.map((point) => point.value)).toEqual([35, 32.5, 10]);
    // The weekly scope still covers every sample, and Fable never exceeds it.
    const weekly = buildRecordedSeries(
      samples,
      [
        { id: 'a', fallbackRemaining: 10 },
        { id: 'never-recorded', fallbackRemaining: 20 },
      ],
      NOW - 6 * HOUR,
      NOW
    );
    expect(weekly.pool.map((point) => point.value)).toEqual([110, 108, 106, 104, 30]);
    fable.pool.forEach((point) => {
      const all = weekly.pool.find((other) => other.t === point.t);
      expect(point.value).toBeLessThanOrEqual(all!.value);
    });
    // Nothing recorded for the scope: no line at all.
    expect(buildRecordedSeries(samples.slice(0, 2), [], NOW - 6 * HOUR, NOW, 'fable').pool).toEqual(
      []
    );
  });

  test('Fable demand draws on the allowance and the weekly quota together', () => {
    const result = simulatePool(
      [
        // 20 of the 50 allowance left, 55 of weekly left.
        { id: 'a', used: 30, capacity: 50, ceiling: 55, resetAtMs: NOW + DAY, periodMs: WEEK_MS },
      ],
      { startMs: NOW, endMs: NOW + 3 * HOUR, burnPerHour: 10 }
    );
    expect(result.pool[0].value).toBe(20);
    expect(result.pool.find((point) => point.t === NOW + HOUR)?.value).toBeCloseTo(10, 9);
    // The allowance runs out after two hours although weekly still has 35.
    expect(result.firstEmpty).toEqual({ accountId: 'a', atMs: NOW + 2 * HOUR });
    expect(result.poolEmptyAtMs).toBe(NOW + 2 * HOUR);
    expect(result.pool[result.pool.length - 1].value).toBe(0);
    const summary = summarizePool(
      [{ id: 'a', used: 30, capacity: 50, ceiling: 55, resetAtMs: NOW + DAY, periodMs: WEEK_MS }],
      result,
      NOW,
      NOW + 3 * HOUR
    );
    expect(summary).toMatchObject({ accountCount: 1, capacity: 50, remaining: 20 });
  });

  test('other models lower the weekly quota Fable needs, and the next account takes over', () => {
    const result = simulatePool(
      [
        // Plenty of allowance, 10 of weekly left: weekly is what binds.
        {
          id: 'tight',
          used: 0,
          capacity: 50,
          ceiling: 10,
          resetAtMs: NOW + DAY,
          periodMs: WEEK_MS,
        },
        {
          id: 'roomy',
          used: 0,
          capacity: 50,
          ceiling: 100,
          resetAtMs: NOW + 2 * DAY,
          periodMs: WEEK_MS,
        },
      ],
      { startMs: NOW, endMs: NOW + 4 * HOUR, burnPerHour: 2, ceilingBurnPerHour: 3 }
    );
    expect(result.pool[0].value).toBe(60);
    expect(result.activeAccountId).toBe('tight');
    expect(result.nextAccountId).toBe('roomy');
    // Fable (2/h) and other models (3/h) both come off "tight"'s weekly quota: gone in 2 h.
    expect(result.perAccount.tight.find((point) => point.t === NOW + HOUR)?.value).toBeCloseTo(
      5,
      9
    );
    expect(result.firstEmpty).toEqual({ accountId: 'tight', atMs: NOW + 2 * HOUR });
    expect(result.emptyAt).toEqual({ tight: NOW + 2 * HOUR, roomy: null });
    // Then both demands move to "roomy": its allowance drops 2/h, its weekly quota 5/h.
    const roomy = result.perAccount.roomy;
    expect(roomy.find((point) => point.t === NOW + 2 * HOUR)?.value).toBeCloseTo(50, 9);
    expect(roomy[roomy.length - 1].value).toBeCloseTo(46, 9);
    expect(result.pool[result.pool.length - 1].value).toBeCloseTo(46, 9);
    expect(result.poolEmptyAtMs).toBeNull();
  });

  test('other-model use alone can leave nothing for Fable', () => {
    const result = simulatePool(
      [{ id: 'a', used: 0, capacity: 50, ceiling: 6, resetAtMs: NOW + DAY, periodMs: WEEK_MS }],
      // Fable burn unknown (0), but the weekly meters are burning 3%/h.
      { startMs: NOW, endMs: NOW + 3 * HOUR, burnPerHour: 0, ceilingBurnPerHour: 3 }
    );
    expect(result.pool.map((point) => Math.round(point.value))[0]).toBe(6);
    expect(result.firstEmpty).toEqual({ accountId: 'a', atMs: NOW + 2 * HOUR });
    expect(result.poolEmptyAtMs).toBe(NOW + 2 * HOUR);
    // Without ceilings the same option changes nothing: the all-models pool has one demand.
    const plain = simulatePool([{ id: 'a', used: 94, resetAtMs: NOW + DAY, periodMs: WEEK_MS }], {
      startMs: NOW,
      endMs: NOW + 3 * HOUR,
      burnPerHour: 0,
      ceilingBurnPerHour: 3,
    });
    expect(plain.pool.every((point) => point.value === 6)).toBe(true);
  });

  test('an account at its weekly limit has no Fable until the weekly reset refills both', () => {
    const resetAt = NOW + HOUR;
    const result = simulatePool(
      [
        // 30 of allowance left, weekly limit reached.
        { id: 'held', used: 20, capacity: 50, ceiling: 0, resetAtMs: resetAt, periodMs: WEEK_MS },
        {
          id: 'free',
          used: 40,
          capacity: 50,
          ceiling: 80,
          resetAtMs: NOW + DAY,
          periodMs: WEEK_MS,
        },
      ],
      { startMs: NOW, endMs: NOW + 2 * HOUR, burnPerHour: 4 }
    );
    // Only "free" counts and serves; "held" is empty from the start.
    expect(result.pool[0].value).toBe(10);
    expect(result.firstEmpty).toEqual({ accountId: 'held', atMs: NOW });
    expect(result.activeAccountId).toBe('free');
    expect(result.nextAccountId).toBeNull();
    // The weekly reset brings back the whole allowance, not the 30 that were left.
    expect(result.stepUps).toEqual([
      { t: resetAt, amount: 50, accountIds: ['held'], kind: 'reset' },
    ]);
    // "held" resets soonest again a week on, so "free" keeps serving: 10 - 8 + 50.
    expect(result.pool[result.pool.length - 1].value).toBeCloseTo(52, 9);
  });

  describe('resets', () => {
    const grant = (overrides: Partial<SimulationGrant>): SimulationGrant => ({
      id: 'g',
      accountId: 'a',
      expiresAtMs: NOW + 6 * HOUR,
      startsAtMs: null,
      policy: 'limit',
      leadMs: 10 * 60_000,
      requiresLimit: true,
      left: 1,
      ...overrides,
    });

    test('a Fable reset in the Fable pool refills the allowance and frees its weekly usage', () => {
      // Allowance used up (50 of weekly spent on Fable), 70 of weekly used in all.
      const result = simulatePool(
        [
          {
            id: 'a',
            used: 50,
            capacity: 50,
            ceiling: 30,
            resetAtMs: NOW + 3 * DAY,
            periodMs: WEEK_MS,
          },
        ],
        {
          startMs: NOW,
          endMs: NOW + HOUR,
          burnPerHour: 0,
          grants: [grant({ fableOnly: true })],
        }
      );
      expect(result.grantOutcomes.g).toEqual({ kind: 'spent', atMs: NOW, amount: 50 });
      expect(result.pool[result.pool.length - 1].value).toBe(50);
      expect(result.stepUps).toEqual([
        { t: NOW, amount: 50, accountIds: ['a'], kind: 'grant', grantId: 'g' },
      ]);
    });

    test('a Fable reset frees only what Fable used: the weekly quota still caps the rest', () => {
      // Weekly limit reached, 20 of it spent on Fable: the reset gives those 20 back.
      const result = simulatePool(
        [
          {
            id: 'a',
            used: 20,
            capacity: 50,
            ceiling: 0,
            resetAtMs: NOW + 3 * DAY,
            periodMs: WEEK_MS,
          },
        ],
        {
          startMs: NOW,
          endMs: NOW + HOUR,
          burnPerHour: 0,
          grants: [grant({ fableOnly: true })],
        }
      );
      expect(result.grantOutcomes.g).toEqual({ kind: 'spent', atMs: NOW, amount: 20 });
      expect(result.pool[result.pool.length - 1].value).toBe(20);
    });

    test('a weekly reset in the Fable pool refills the allowance and the weekly quota', () => {
      const result = simulatePool(
        [
          {
            id: 'a',
            used: 20,
            capacity: 50,
            ceiling: 0,
            resetAtMs: NOW + 3 * DAY,
            periodMs: WEEK_MS,
          },
        ],
        { startMs: NOW, endMs: NOW + HOUR, burnPerHour: 0, grants: [grant({})] }
      );
      expect(result.grantOutcomes.g).toEqual({ kind: 'spent', atMs: NOW, amount: 50 });
      // Claude refuses it while Fable can still be served, right up to its expiry.
      const refused = simulatePool(
        [
          {
            id: 'a',
            used: 20,
            capacity: 50,
            ceiling: 40,
            resetAtMs: NOW + 3 * DAY,
            periodMs: WEEK_MS,
          },
        ],
        {
          startMs: NOW,
          endMs: NOW + 7 * HOUR,
          burnPerHour: 0,
          grants: [grant({ policy: 'expiry' })],
        }
      );
      expect(refused.grantOutcomes.g).toEqual({
        kind: 'unused',
        atMs: NOW + 6 * HOUR - 10 * 60_000,
        reason: 'not_limited',
      });
      expect(refused.pool.every((point) => point.value === 30)).toBe(true);
    });

    test('in the all-models pool a Fable reset gives back the Fable spend, once', () => {
      // Weekly limit reached; 28 of it went to Fable.
      const account = {
        id: 'a',
        used: 100,
        fableSpend: 28,
        resetAtMs: NOW + 3 * DAY,
        periodMs: WEEK_MS,
      };
      const result = simulatePool([account], {
        startMs: NOW,
        endMs: NOW + 3 * HOUR,
        burnPerHour: 0,
        grants: [
          grant({ id: 'first', fableOnly: true }),
          // A second Fable reset, spent before it expires whether limited or not.
          grant({
            id: 'second',
            fableOnly: true,
            policy: 'expiry',
            requiresLimit: false,
            expiresAtMs: NOW + 2 * HOUR,
          }),
        ],
      });
      // Not the +100 a weekly reset gives.
      expect(result.grantOutcomes.first).toEqual({ kind: 'spent', atMs: NOW, amount: 28 });
      expect(result.pool[result.pool.length - 1].value).toBe(28);
      // Nothing is left to give back the second time.
      expect(result.grantOutcomes.second).toEqual({
        kind: 'spent',
        atMs: NOW + 2 * HOUR - 10 * 60_000,
        amount: 0,
      });
      expect(result.stepUps.map((event) => event.grantId)).toEqual(['first']);

      const weekly = simulatePool([account], {
        startMs: NOW,
        endMs: NOW + HOUR,
        burnPerHour: 0,
        grants: [grant({})],
      });
      expect(weekly.grantOutcomes.g).toEqual({ kind: 'spent', atMs: NOW, amount: 100 });
    });

    test('the all-models pool estimates Fable spend ahead from the Fable share of demand', () => {
      const later = grant({
        fableOnly: true,
        policy: 'expiry',
        requiresLimit: false,
        expiresAtMs: NOW + 2 * HOUR + 10 * 60_000,
      });
      const fresh = { id: 'a', used: 0, resetAtMs: NOW + 3 * DAY, periodMs: WEEK_MS };
      const options = { startMs: NOW, endMs: NOW + 3 * HOUR, burnPerHour: 10, grants: [later] };
      // Two hours at 10%/h, 30% of it Fable: 6 points to give back.
      const run = simulatePool([fresh], { ...options, fableShare: 0.3 });
      expect(run.grantOutcomes.g).toMatchObject({ kind: 'spent', atMs: NOW + 2 * HOUR });
      expect((run.grantOutcomes.g as { amount: number }).amount).toBeCloseTo(6, 9);
      // Fable can never account for more than half of the weekly limit.
      const heavy = simulatePool([fresh], { ...options, burnPerHour: 40, fableShare: 1 });
      expect((heavy.grantOutcomes.g as { amount: number }).amount).toBeCloseTo(50, 9);
      // A weekly reset on the way clears the Fable spend with everything else.
      const resetFirst = simulatePool(
        [{ ...fresh, used: 10, fableSpend: 5, resetAtMs: NOW + HOUR }],
        {
          ...options,
          fableShare: 0.3,
        }
      );
      expect((resetFirst.grantOutcomes.g as { amount: number }).amount).toBeCloseTo(3, 9);
      // Without a known share nothing is assumed beyond what was spent already.
      const unknown = simulatePool([{ ...fresh, used: 10, fableSpend: 5 }], options);
      expect(unknown.grantOutcomes.g).toMatchObject({ kind: 'spent', amount: 5 });
    });

    test('grants are classified by what they give back', () => {
      const effect = (provider: string, clears: string[]) => resetGrantEffect({ provider, clears });
      expect(effect('claude', ['seven_day', 'seven_day_overage_included'])).toBe('weekly');
      expect(effect('claude', ['seven_day', 'five_hour'])).toBe('weekly');
      expect(effect('claude', ['seven_day_overage_included'])).toBe('fable');
      expect(effect('claude', ['five_hour'])).toBe('none');
      expect(effect('claude', [])).toBe('none');
      // Codex credits name no windows: they reset every one.
      expect(effect('codex', [])).toBe('weekly');
    });
  });

  describe('pool view', () => {
    const account = (
      key: string,
      weeklyUsed: number,
      fableUsed: number | null,
      resetAtMs: number = NOW + 2 * DAY
    ): PoolAccount => ({
      key,
      authIndex: key,
      provider: 'claude',
      file: { name: `${key}.json`, provider: 'claude', authIndex: key },
      quota: {
        weekly: { used: weeklyUsed, resetAtMs, periodMs: WEEK_MS, rolled: false },
        fiveHour: null,
        fable:
          fableUsed === null
            ? null
            : { used: fableUsed, resetAtMs, periodMs: WEEK_MS, rolled: false },
        source: 'signals',
        observedAtMs: NOW,
      },
      status:
        weeklyUsed >= 100
          ? { kind: 'weekly_exhausted', untilMs: resetAtMs }
          : { kind: 'available', untilMs: null },
    });
    const resetGrant = (id: string, accountId: string, clears: string[]): ResetGrant => ({
      id,
      accountId,
      provider: 'claude',
      label: '',
      clears,
      startsAtMs: null,
      expiresAtMs: NOW + 6 * HOUR,
      left: 1,
      total: 1,
      usable: true,
      requiresLimit: true,
      policy: 'limit',
      policySet: true,
      nextActionAtMs: null,
      state: 'pending',
      last: null,
    });
    // "b" is at its weekly limit with Fable allowance left; "c" reports no Fable window.
    const accounts = [
      account('a', 40, 10),
      account('b', 100, 60, NOW + DAY),
      account('c', 20, null),
    ];
    const history = {
      intervalMs: HOUR,
      updatedMs: NOW,
      // "a": weekly +3 an hour, its Fable meter +2 an hour (1 weekly point).
      samples: [0, 1, 2, 3].map((i) =>
        both(NOW - (3 - i) * HOUR, { a: [31 + i * 3, 4 + i * 2], b: [100, 60], c: [20, null] })
      ),
    };
    const base = {
      accounts,
      history,
      nowMs: NOW,
      range: poolRange(NOW),
      burnWindowHours: 3,
      futureUsage: 'same' as const,
    };

    test('measures what Fable can still use, in weekly points', () => {
      const fable = buildPoolView({ ...base, scope: 'fable' });
      expect(fable.scope).toBe('fable');
      expect(fable.members.map((member) => member.key)).toEqual(['a', 'b']);
      expect(fable.missing.map((member) => member.key)).toEqual(['c']);
      // Two accounts can hold 50 each. "a" has 45 (90% of its allowance); "b" has
      // 20 of allowance left but no weekly quota, so nothing.
      expect(fable.summary).toMatchObject({ accountCount: 2, capacity: 100, remaining: 45 });
      expect(fable.hasHistory).toBe(true);
      // 1%/h of weekly goes to Fable; the other 2%/h of "a"'s 3%/h is other models.
      expect(fable.burn.ratePerHour).toBe(1);
      expect(fable.projectedBurnPerHour).toBe(1);
      expect(fable.projectedOtherBurnPerHour).toBe(2);
      expect(buildPoolView({ ...base, scope: 'fable', futureUsage: 'double' })).toMatchObject({
        projectedBurnPerHour: 2,
        projectedOtherBurnPerHour: 4,
      });
      // "b" resets sooner but cannot serve Fable: "a" does, and nobody is next.
      expect(fable.plan.activeId).toBe('a');
      expect(fable.plan.nextId).toBeNull();
      // "a" has 60 of weekly left burning 3%/h: gone in 20 h, before the allowance (45 h).
      expect(fable.plan.emptyAt.a).toBe(NOW + 20 * HOUR);
      expect(fable.remaining.recorded[fable.remaining.recorded.length - 1]).toEqual({
        t: NOW,
        value: 45,
      });

      const all = buildPoolView(base);
      expect(all.scope).toBe('all');
      expect(all.members.map((member) => member.key)).toEqual(['a', 'b', 'c']);
      expect(all.summary).toMatchObject({ capacity: 300, remaining: 140 });
      expect(all.burn.ratePerHour).toBe(3);
      expect(all.projectedOtherBurnPerHour).toBe(0);
      // Fable is a part of the weekly limit: never the larger figure.
      expect(fable.summary.remaining).toBeLessThanOrEqual(all.summary.remaining);
      expect(fable.burn.ratePerHour).toBeLessThanOrEqual(all.burn.ratePerHour);
    });

    test('both views agree on what a reset gives back', () => {
      const grants = [
        resetGrant('full', 'b', ['seven_day', 'seven_day_overage_included']),
        resetGrant('fable', 'b', ['seven_day_overage_included']),
        resetGrant('session', 'a', ['five_hour']),
      ];
      // A weekly reset on the limited account: everything back in either view.
      const fullOnly = { ...base, grants: [grants[0]] };
      expect(buildPoolView(fullOnly).grants.outcomes['b:full']).toEqual({
        kind: 'spent',
        atMs: NOW,
        amount: 100,
      });
      expect(buildPoolView({ ...fullOnly, scope: 'fable' }).grants.outcomes['b:full']).toEqual({
        kind: 'spent',
        atMs: NOW,
        amount: 50,
      });
      // A Fable reset: "b" spent 30 of its weekly limit on Fable (60% of the
      // allowance), and gets exactly that back in either view, not a full week.
      const fableOnly = { ...base, grants: [grants[1]] };
      expect(buildPoolView(fableOnly).grants.outcomes['b:fable']).toEqual({
        kind: 'spent',
        atMs: NOW,
        amount: 30,
      });
      expect(buildPoolView({ ...fableOnly, scope: 'fable' }).grants.outcomes['b:fable']).toEqual({
        kind: 'spent',
        atMs: NOW,
        amount: 30,
      });
      // Further ahead, the all-models view adds the Fable share of what "a" burns
      // meanwhile (a third of 3%/h) to the 5 points it has spent on Fable so far.
      const ahead = { ...resetGrant('later', 'a', ['seven_day_overage_included']) };
      ahead.policy = 'expiry';
      ahead.requiresLimit = false;
      const outcome = buildPoolView({ ...base, grants: [ahead] }).grants.outcomes['a:later'];
      const dueMs = NOW + 6 * HOUR - 10 * 60_000;
      expect(outcome).toMatchObject({ kind: 'spent', atMs: dueMs });
      expect((outcome as { amount: number }).amount).toBeCloseTo(5 + (dueMs - NOW) / HOUR, 6);
      // Every pending grant on a member is listed; the 5-hour one is not simulated.
      const view = buildPoolView({ ...base, scope: 'fable', grants });
      expect(view.grants.pending.map((item) => item.id).sort()).toEqual([
        'fable',
        'full',
        'session',
      ]);
      expect(view.grants.outcomes['a:session']).toBeUndefined();
    });
  });
});
