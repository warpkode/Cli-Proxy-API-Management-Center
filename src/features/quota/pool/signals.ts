/**
 * Turn hub-cached data into per-account quota readings. React-free.
 *
 * Three sources, none of which calls upstream:
 * - credential signals: rate-limit response headers the hub cached per credential;
 * - claude-seat-pacer: the plugin's own usage-endpoint snapshots (Claude only);
 * - history.json: the recorder's 5-minute samples.
 *
 * Claude accounts carry a third window next to weekly and 5-hour: the weekly
 * limit scoped to Fable, which the pool can be measured against on its own.
 */

import type { AuthFileQuotaSignals } from '@/types/authFile';
import type { SeatPacerAccount, SeatPacerWindow } from '@/services/api/seatPacer';
import { isFableModelName } from '@/utils/quota/validators';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import { parseTimestampMs } from '@/utils/timestamp';
import type { HistoryAccountSample, QuotaReading, QuotaWindowReading } from './types';

export const WEEK_MS = 7 * DAY_MS;
export const FIVE_HOUR_MS = 5 * HOUR_MS;

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

const readNumber = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Epoch seconds, epoch milliseconds or an ISO instant. */
export const readInstantMs = (value: string | number | undefined | null): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e12 ? value * 1000 : value;
  }
  const numeric = readNumber(value);
  if (numeric !== null) return readInstantMs(numeric);
  const parsed = parseTimestampMs(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Case-insensitive header lookup: proxies and HTTP/2 may lower-case names. */
const signalReader = (signals: Record<string, string>) => {
  const byName = new Map<string, string>();
  for (const [key, value] of Object.entries(signals)) byName.set(key.toLowerCase(), value);
  return (name: string) => byName.get(name.toLowerCase());
};

const CLAUDE_PREFIX = 'anthropic-ratelimit-unified';

/**
 * The unified headers name the Fable-scoped weekly window `7d_oi`. The name is
 * opaque: it is read as Fable because it carries the same utilization and reset
 * instant as the usage endpoint's `weekly_scoped` Fable limit. The seat-pacer
 * names its scope, so its reading wins whenever it is at least as fresh.
 */
const CLAUDE_FABLE_WINDOW = '7d_oi';

const readClaudeWindow = (
  read: (name: string) => string | undefined,
  window: string,
  periodMs: number
): QuotaWindowReading | null => {
  const utilization = readNumber(read(`${CLAUDE_PREFIX}-${window}-utilization`));
  if (utilization === null) return null;
  const status = read(`${CLAUDE_PREFIX}-${window}-status`)?.trim();
  return {
    used: clampPercent(utilization * 100),
    resetAtMs: readInstantMs(read(`${CLAUDE_PREFIX}-${window}-reset`)),
    periodMs,
    ...(status ? { status } : {}),
  };
};

export function readClaudeSignals(
  signals: Record<string, string>,
  observedAtMs: number | null
): QuotaReading | null {
  const read = signalReader(signals);
  const weekly = readClaudeWindow(read, '7d', WEEK_MS);
  const fiveHour = readClaudeWindow(read, '5h', FIVE_HOUR_MS);
  const fable = readClaudeWindow(read, CLAUDE_FABLE_WINDOW, WEEK_MS);
  if (!weekly && !fiveHour && !fable) return null;
  return { source: 'signals', observedAtMs, weekly, fiveHour, fable };
}

interface CodexWindow {
  reading: QuotaWindowReading;
  minutes: number | null;
}

const readCodexWindow = (
  read: (name: string) => string | undefined,
  slot: 'primary' | 'secondary'
): CodexWindow | null => {
  const used = readNumber(read(`x-codex-${slot}-used-percent`));
  const minutes = readNumber(read(`x-codex-${slot}-window-minutes`));
  // "0" minutes is the server's way of saying the slot carries no window.
  if (used === null || minutes === 0) return null;
  return {
    minutes,
    reading: {
      used: clampPercent(used),
      resetAtMs: readInstantMs(read(`x-codex-${slot}-reset-at`)),
      periodMs: minutes !== null && minutes > 0 ? minutes * MINUTE_MS : WEEK_MS,
    },
  };
};

/**
 * Codex reports two slots whose meaning depends on the plan: Pro puts the weekly
 * window in `primary` (10080 minutes) and leaves `secondary` empty, while other
 * plans pair a 5-hour primary with a weekly secondary. Classify by window length;
 * fall back to slot position only when the length is missing.
 */
export function readCodexSignals(
  signals: Record<string, string>,
  observedAtMs: number | null
): QuotaReading | null {
  const read = signalReader(signals);
  const primary = readCodexWindow(read, 'primary');
  const secondary = readCodexWindow(read, 'secondary');
  const isWeekly = (window: CodexWindow, positionalWeekly: boolean) =>
    window.minutes === null ? positionalWeekly : window.minutes >= DAY_MS / MINUTE_MS;
  // Secondary first: when both slots claim the same kind, the secondary wins,
  // matching the 5-hour-primary / weekly-secondary layout.
  const slots: CodexWindow[] = [];
  if (secondary) slots.push(secondary);
  if (primary) slots.push(primary);
  const weekly =
    slots.find((window) => isWeekly(window, window === secondary || !secondary))?.reading ?? null;
  const fiveHour =
    slots.find((window) => !isWeekly(window, window === secondary || !secondary))?.reading ?? null;

  if (!weekly && !fiveHour) return null;
  const plan = read('x-codex-plan-type')?.trim();
  return {
    source: 'signals',
    observedAtMs,
    weekly,
    fiveHour,
    ...(plan ? { plan } : {}),
  };
}

export function readCredentialSignals(
  provider: string,
  quotaSignals: AuthFileQuotaSignals | undefined
): QuotaReading | null {
  if (!quotaSignals) return null;
  const observedAtMs = readInstantMs(quotaSignals.observedAt ?? null);
  if (provider === 'claude') return readClaudeSignals(quotaSignals.signals, observedAtMs);
  if (provider === 'codex') return readCodexSignals(quotaSignals.signals, observedAtMs);
  return null;
}

export function readSeatPacerAccount(account: SeatPacerAccount): QuotaReading | null {
  const toReading = (
    matches: (window: SeatPacerWindow) => boolean,
    periodMs: number
  ): QuotaWindowReading | null => {
    const window = account.windows.find(matches);
    if (!window) return null;
    return {
      used: clampPercent(window.utilization * 100),
      resetAtMs: window.resetsAtMs,
      periodMs,
      ...(window.status ? { status: window.status } : {}),
    };
  };
  const weekly = toReading((window) => window.kind === 'seven_day', WEEK_MS);
  const fiveHour = toReading((window) => window.kind === 'five_hour', FIVE_HOUR_MS);
  // `weekly_scoped` covers any model-scoped limit; only the Fable one is pooled.
  const fable = toReading(
    (window) => window.kind === 'weekly_scoped' && isFableModelName(window.scope),
    WEEK_MS
  );
  if (!weekly && !fiveHour && !fable) return null;
  return { source: 'seat-pacer', observedAtMs: account.observedAtMs, weekly, fiveHour, fable };
}

export function readHistoryAccount(
  sample: HistoryAccountSample,
  sampleAtMs: number
): QuotaReading | null {
  if (!sample.weekly && !sample.fiveHour && !sample.fable) return null;
  const weekLong = (window: HistoryAccountSample['weekly']): QuotaWindowReading | null =>
    window ? { used: window.used, resetAtMs: window.resetAtMs, periodMs: WEEK_MS } : null;
  return {
    source: 'history',
    observedAtMs: sample.seenMs ?? sampleAtMs,
    weekly: weekLong(sample.weekly),
    fiveHour: sample.fiveHour
      ? {
          used: sample.fiveHour.used,
          resetAtMs: sample.fiveHour.resetAtMs,
          periodMs: FIVE_HOUR_MS,
        }
      : null,
    fable: weekLong(sample.fable ?? null),
    ...(sample.plan ? { plan: sample.plan } : {}),
  };
}
