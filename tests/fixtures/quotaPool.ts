/**
 * Pooled quota fixtures shaped like the hub's real payloads (values invented,
 * addresses on example.com). Times are anchored to a fixed `NOW` so every test
 * and the static render are deterministic.
 */

import type { AuthFilesResponse } from '@/types';

export const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
const sec = (ms: number) => Math.floor(ms / 1000);

export const claudeSignals = (used7d: number, reset7dMs: number, used5h = 0.2) => ({
  'Anthropic-Ratelimit-Unified-5h-Utilization': String(used5h),
  'Anthropic-Ratelimit-Unified-5h-Reset': String(sec(NOW + 3 * HOUR)),
  'Anthropic-Ratelimit-Unified-5h-Status': 'allowed',
  'Anthropic-Ratelimit-Unified-7d-Utilization': String(used7d),
  'Anthropic-Ratelimit-Unified-7d-Reset': String(sec(reset7dMs)),
  'Anthropic-Ratelimit-Unified-7d-Status': used7d >= 1 ? 'rejected' : 'allowed',
  'Anthropic-Ratelimit-Unified-Status': 'allowed',
  'Anthropic-Ratelimit-Unified-Representative-Claim': 'seven_day',
});

export const codexSignals = (usedPercent: number, resetMs: number) => ({
  'X-Codex-Plan-Type': 'pro',
  'X-Codex-Primary-Used-Percent': String(usedPercent),
  'X-Codex-Primary-Reset-At': String(sec(resetMs)),
  'X-Codex-Primary-Window-Minutes': '10080',
  'X-Codex-Secondary-Used-Percent': '0',
  'X-Codex-Secondary-Reset-At': '0',
  'X-Codex-Secondary-Window-Minutes': '0',
  'X-Codex-Credits-Balance': '0',
});

const observed = (ms: number) => new Date(ms).toISOString();

/** `GET /v8/management/credentials` with four Claude accounts and one Codex Pro. */
export const credentialsPayload = (): AuthFilesResponse => ({
  observed_at: observed(NOW),
  files: [
    {
      name: 'claude-alpha@example.com.json',
      provider: 'claude',
      auth_index: 'c1',
      email: 'alpha@example.com',
      label: 'alpha@example.com',
      status: 'active',
      disabled: false,
      unavailable: false,
      cooldowns: [],
      quota: { observed_at: observed(NOW - 2 * HOUR), signals: claudeSignals(0.4, NOW + 2 * DAY) },
    },
    {
      name: 'claude-bravo@example.com.json',
      provider: 'claude',
      auth_index: 'c2',
      email: 'bravo@example.com',
      status: 'active',
      disabled: false,
      cooldowns: [],
      quota: { observed_at: observed(NOW - 5 * HOUR), signals: claudeSignals(0.1, NOW + 5 * DAY) },
    },
    {
      name: 'claude-charlie@example.com.json',
      provider: 'claude',
      auth_index: 'c3',
      email: 'charlie@example.com',
      status: 'error',
      unavailable: true,
      disabled: false,
      cooldowns: [
        {
          scope: 'credential',
          reason: 'credential_quota',
          retry_at: observed(NOW + 20 * HOUR),
          remaining_seconds: 72000,
        },
      ],
      quota: { observed_at: observed(NOW - HOUR), signals: claudeSignals(1, NOW + 20 * HOUR) },
    },
    {
      // Idle account whose cached weekly reset already passed.
      name: 'claude-delta@example.com.json',
      provider: 'claude',
      auth_index: 'c4',
      email: 'delta@example.com',
      status: 'active',
      disabled: false,
      cooldowns: [],
      quota: { observed_at: observed(NOW - 9 * DAY), signals: claudeSignals(0.7, NOW - 2 * DAY) },
    },
    {
      name: 'codex-echo@example.com.json',
      provider: 'codex',
      auth_index: 'x1',
      email: 'echo@example.com',
      status: 'active',
      disabled: false,
      account_type: 'oauth',
      cooldowns: [],
      quota: { observed_at: observed(NOW - 30 * 60_000), signals: codexSignals(55, NOW + 3 * DAY) },
    },
  ],
});

/** claude-seat-pacer status; fresher than c1's signals, older than c3's. */
export const seatPacerPayload = () => ({
  polled_at: observed(NOW - 60_000),
  next_poll_at: observed(NOW + 60_000),
  now: observed(NOW),
  config: { quota: { poll_interval: '2m' } },
  auths: [
    {
      auth_id: 'claude-alpha@example.com.json',
      email: 'alpha@example.com',
      snapshot: {
        auth_index: 'c1',
        observed_at: observed(NOW - 60_000),
        source: 'usage-endpoint',
        windows: [
          {
            kind: 'five_hour',
            utilization: 0.35,
            resets_at: observed(NOW + 2 * HOUR),
            active: true,
            severity: 'normal',
          },
          {
            kind: 'seven_day',
            utilization: 0.45,
            resets_at: observed(NOW + 2 * DAY),
            active: true,
            severity: 'normal',
          },
          {
            kind: 'weekly_scoped',
            utilization: 0.2,
            resets_at: observed(NOW + 2 * DAY),
            active: true,
            severity: 'normal',
            scope: 'opus',
          },
        ],
      },
    },
    {
      auth_id: 'claude-charlie@example.com.json',
      snapshot: {
        auth_index: 'c3',
        observed_at: observed(NOW - 3 * HOUR),
        source: 'usage-endpoint',
        windows: [
          {
            kind: 'seven_day',
            utilization: 0.9,
            resets_at: observed(NOW + 20 * HOUR),
            active: true,
            severity: 'critical',
          },
        ],
      },
    },
  ],
});

/**
 * history.json: 5-minute samples over the last `days`, c1 burning 1%/h from 20%
 * and c2 burning 0.5%/h; c2 reset two days ago (a drop the burn must ignore).
 */
export const historyPayload = (days = 3) => {
  const interval = 300;
  const samples = [];
  const start = NOW - days * DAY;
  for (let t = start; t <= NOW - 5 * 60_000; t += interval * 1000) {
    const hours = (t - start) / HOUR;
    const c2Hours = t < NOW - 2 * DAY ? hours : (t - (NOW - 2 * DAY)) / HOUR;
    samples.push({
      t: sec(t),
      a: [
        {
          id: 'c1',
          p: 'claude',
          on: true,
          w: { used: Math.min(100, 20 + hours * 1), reset: sec(NOW + 2 * DAY) },
          f: { used: 10, reset: sec(t + 2 * HOUR) },
          seen: sec(t),
          src: 'usage',
        },
        {
          id: 'c2',
          p: 'claude',
          on: true,
          w: {
            used: Math.min(100, 40 + c2Hours * 0.5),
            reset: sec(t < NOW - 2 * DAY ? NOW - 2 * DAY : NOW + 5 * DAY),
          },
          f: null,
          seen: sec(t),
          src: 'headers',
        },
        {
          id: 'x1',
          p: 'codex',
          on: true,
          w: { used: 50, reset: sec(NOW + 3 * DAY) },
          f: null,
          seen: sec(t),
          src: 'headers',
          plan: 'pro',
        },
      ],
    });
  }
  return { version: 1, interval, updated: sec(NOW - 5 * 60_000), samples };
};
