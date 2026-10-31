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
} from '@/features/quota/pool/poolModel';
import { buildPoolView, niceCeiling } from '@/features/quota/pool/poolView';
import { WEEK_MS } from '@/features/quota/pool/signals';
import type { HistorySample, QuotaReading } from '@/features/quota/pool/types';
import type { PoolAccount } from '@/features/quota/pool/accounts';

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
    expect(result.stepUps).toEqual([{ t: resetAt, amount: 100, accountIds: ['a'] }]);
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
    expect(result.stepUps).toEqual([{ t: resetAt, amount: 90, accountIds: ['a', 'b'] }]);
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
    expect(view.summary.nextReset).toEqual({ t: NOW + 2 * DAY, amount: 40, accountIds: ['a'] });
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
