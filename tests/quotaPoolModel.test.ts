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
import type { HistorySample, QuotaReading } from '@/features/quota/pool/types';
import type { PoolAccount } from '@/features/quota/pool/accounts';
import type { ResetGrant } from '@/services/api/quotaResets';

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
  /** One sample carrying `[weekly used, Fable used]` per account; null leaves a window out. */
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

  test('burn follows the scope and needs samples that record it', () => {
    const samples = [
      both(NOW - 3 * HOUR, { a: [10, 2] }),
      both(NOW - 2 * HOUR, { a: [20, 4] }),
      both(NOW - HOUR, { a: [30, 6] }),
      both(NOW, { a: [40, 8] }),
    ];
    const ids = new Set(['a']);
    expect(computeBurnRate(buildBurnIndex(samples, ids), NOW, 3).ratePerHour).toBe(10);
    expect(computeBurnRate(buildBurnIndex(samples, ids, 'fable'), NOW, 3).ratePerHour).toBe(2);
    // Weekly-only samples (an older recorder) give the Fable scope nothing to measure.
    const weeklyOnly = samples.map((item) => sample(item.t, { a: item.accounts[0].weekly!.used }));
    expect(computeBurnRate(buildBurnIndex(weeklyOnly, ids, 'fable'), NOW, 3).ratePerHour).toBe(0);
  });

  test('burn coverage starts where the scope was first recorded', () => {
    // Three hours of weekly samples; Fable only in the last hour, burning 2%/h.
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
      ratePerHour: 2,
      coveredHours: 1,
      sufficient: true,
    });
    // The drain chart draws nothing before there is recorded coverage.
    expect(computeBurnSeries(index, 1, NOW - 3 * HOUR, NOW)).toEqual([
      { t: NOW - HOUR / 2, value: 2 },
      { t: NOW, value: 2 },
    ]);
    // A scope nobody recorded has no burn at all.
    const none = buildBurnIndex(samples.slice(0, 2), new Set(['a']), 'fable');
    expect(none.recordedFromMs).toBeNull();
    expect(computeBurnRate(none, NOW - 2 * HOUR, 1).sufficient).toBe(false);
    expect(computeBurnSeries(none, 1, NOW - 3 * HOUR, NOW)).toEqual([]);
    // The weekly scope of the same samples is measured over all three hours.
    expect(computeBurnRate(buildBurnIndex(samples, new Set(['a'])), NOW, 3).ratePerHour).toBe(10);
  });

  test('the recorded line starts at the first sample that records the scope', () => {
    const samples = [
      both(NOW - 4 * HOUR, { a: [10, null] }),
      both(NOW - 3 * HOUR, { a: [12, null] }),
      both(NOW - 2 * HOUR, { a: [14, 30] }),
      both(NOW - HOUR, { a: [16, 35] }),
    ];
    const accounts = [
      { id: 'a', fallbackRemaining: 60 },
      { id: 'never-recorded', fallbackRemaining: 80 },
    ];
    const fable = buildRecordedSeries(samples, accounts, NOW - 5 * HOUR, NOW, 'fable');
    // No flat back-filled line across the hours before Fable was recorded.
    expect(fable.pool).toEqual([
      { t: NOW - 2 * HOUR, value: 70 + 80 },
      { t: NOW - HOUR, value: 65 + 80 },
    ]);
    // The weekly scope still covers every sample.
    const weekly = buildRecordedSeries(samples, accounts, NOW - 5 * HOUR, NOW);
    expect(weekly.pool.map((point) => point.value)).toEqual([170, 168, 166, 164]);
    // Nothing recorded for the scope: no line at all.
    expect(
      buildRecordedSeries(samples.slice(0, 2), accounts, NOW - 5 * HOUR, NOW, 'fable').pool
    ).toEqual([]);
  });

  test('a blocked account counts toward the total but serves only once released', () => {
    const result = simulatePool(
      [
        {
          id: 'held',
          used: 20,
          resetAtMs: NOW + 2 * HOUR,
          periodMs: WEEK_MS,
          blockedUntilMs: NOW + 2 * HOUR,
        },
        { id: 'free', used: 80, resetAtMs: NOW + DAY, periodMs: WEEK_MS },
      ],
      { startMs: NOW, endMs: NOW + 4 * HOUR, burnPerHour: 20 }
    );
    // 80 held + 20 free.
    expect(result.pool[0].value).toBe(100);
    // "held" resets soonest but cannot serve, so "free" is drained and nobody is next.
    expect(result.activeAccountId).toBe('free');
    expect(result.nextAccountId).toBeNull();
    expect(result.firstEmpty).toEqual({ accountId: 'free', atMs: NOW + HOUR });
    // Nothing can serve from then on, although "held" still shows 80.
    expect(result.poolEmptyAtMs).toBe(NOW + HOUR);
    expect(result.pool.find((point) => point.t === NOW + HOUR)?.value).toBeCloseTo(80, 9);
    expect(result.emptyAt.held).toBeNull();
    // At +2 h it resets and is released, then serves 20%/h for the last two hours.
    expect(result.stepUps).toEqual([
      { t: NOW + 2 * HOUR, amount: 20, accountIds: ['held'], kind: 'reset' },
    ]);
    const held = result.perAccount.held;
    expect(held[held.length - 1].value).toBeCloseTo(60, 9);
  });

  test('a block lifts at its own instant, has no effect once passed, and may never lift', () => {
    const midStep = simulatePool(
      [
        {
          id: 'a',
          used: 0,
          resetAtMs: NOW + DAY,
          periodMs: WEEK_MS,
          blockedUntilMs: NOW + 20 * 60_000,
        },
      ],
      { startMs: NOW, endMs: NOW + HOUR, burnPerHour: 60 }
    );
    // Idle for 20 minutes, then 1% a minute.
    expect(midStep.poolEmptyAtMs).toBe(NOW);
    expect(midStep.activeAccountId).toBeNull();
    expect(midStep.pool.map((point) => Math.round(point.value))).toEqual([100, 100, 90, 75, 60]);

    const passed = simulatePool(
      [
        {
          id: 'a',
          used: 50,
          resetAtMs: NOW + DAY,
          periodMs: WEEK_MS,
          blockedUntilMs: NOW - HOUR,
        },
      ],
      { startMs: NOW, endMs: NOW + HOUR, burnPerHour: 10 }
    );
    expect(passed.activeAccountId).toBe('a');
    expect(passed.poolEmptyAtMs).toBeNull();

    const never = simulatePool(
      [
        {
          id: 'a',
          used: 50,
          resetAtMs: null,
          periodMs: WEEK_MS,
          blockedUntilMs: Number.POSITIVE_INFINITY,
        },
      ],
      { startMs: NOW, endMs: NOW + HOUR, burnPerHour: 10 }
    );
    expect(never.poolEmptyAtMs).toBe(NOW);
    expect(never.pool[never.pool.length - 1].value).toBe(50);
  });

  test('the pool view measures the Fable window and leaves reset grants out of it', () => {
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
    // "b" is at its weekly limit with Fable quota left; "c" reports no Fable window.
    const accounts = [
      account('a', 40, 10),
      account('b', 100, 30, NOW + DAY),
      account('c', 20, null),
    ];
    const grant: ResetGrant = {
      id: 'grant_b',
      accountId: 'b',
      provider: 'claude',
      label: '',
      clears: ['seven_day'],
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
    };
    const history = {
      intervalMs: HOUR,
      updatedMs: NOW,
      samples: [0, 1, 2, 3].map((i) =>
        both(NOW - (3 - i) * HOUR, { a: [31 + i * 3, 4 + i * 2], b: [100, 30], c: [20, null] })
      ),
    };
    const base = {
      accounts,
      history,
      nowMs: NOW,
      range: poolRange(NOW),
      burnWindowHours: 3,
      futureUsage: 'same' as const,
      grants: [grant],
    };

    const fable = buildPoolView({ ...base, scope: 'fable' });
    expect(fable.scope).toBe('fable');
    expect(fable.members.map((member) => member.key)).toEqual(['a', 'b']);
    expect(fable.missing.map((member) => member.key)).toEqual(['c']);
    expect(fable.blocked.map((member) => member.key)).toEqual(['b']);
    expect(fable.summary).toMatchObject({ accountCount: 2, capacity: 200, remaining: 160 });
    // 2%/h of the Fable limit, not the 3%/h the weekly window burns.
    expect(fable.hasHistory).toBe(true);
    expect(fable.burn.ratePerHour).toBe(2);
    // "b" resets sooner but is blocked: "a" serves, and nobody else can.
    expect(fable.plan.activeId).toBe('a');
    expect(fable.plan.nextId).toBeNull();
    // No grant is known to restore the Fable window.
    expect(fable.grants.pending).toEqual([]);
    expect(fable.grants.outcomes).toEqual({});
    expect(fable.remaining.projectedStepUps.every((event) => event.kind === 'reset')).toBe(true);

    const all = buildPoolView(base);
    expect(all.scope).toBe('all');
    expect(all.members.map((member) => member.key)).toEqual(['a', 'b', 'c']);
    expect(all.blocked).toEqual([]);
    expect(all.burn.ratePerHour).toBe(3);
    expect(all.grants.pending.map((item) => item.id)).toEqual(['grant_b']);
    expect(all.grants.outcomes['b:grant_b']).toMatchObject({ kind: 'spent', atMs: NOW });
  });
});
