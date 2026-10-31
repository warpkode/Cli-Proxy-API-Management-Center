/**
 * Join credentials, seat-pacer snapshots and recorded history into pool
 * accounts, and derive each account's serving status. React-free.
 */

import type { AuthFileItem } from '@/types';
import type { SeatPacerStatus } from '@/services/api/seatPacer';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { parseTimestampMs } from '@/utils/timestamp';
import { resolveAccountQuota, type SimulationAccount } from './poolModel';
import { readCredentialSignals, readHistoryAccount, readSeatPacerAccount } from './signals';
import type {
  HistoryAccountSample,
  QuotaHistory,
  QuotaReading,
  ResolvedAccountQuota,
} from './types';

export type AccountStatusKind =
  'available' | 'weekly_exhausted' | 'five_hour_blocked' | 'cooldown' | 'unavailable' | 'no_data';

export interface AccountStatus {
  kind: AccountStatusKind;
  untilMs: number | null;
}

export interface PoolAccount {
  /** Stable key: auth_index when present, else the file name. */
  key: string;
  authIndex: string | null;
  provider: string;
  file: AuthFileItem;
  quota: ResolvedAccountQuota;
  status: AccountStatus;
}

export interface PoolSources {
  files: readonly { file: AuthFileItem; type: string }[];
  seatPacer: SeatPacerStatus | null;
  history: QuotaHistory | null;
}

/** Latest history entry per account id that carries any window. */
export function latestHistoryById(
  history: QuotaHistory | null
): Map<string, { sample: HistoryAccountSample; t: number }> {
  const latest = new Map<string, { sample: HistoryAccountSample; t: number }>();
  if (!history) return latest;
  for (let index = history.samples.length - 1; index >= 0; index -= 1) {
    const { t, accounts } = history.samples[index];
    for (const account of accounts) {
      if (latest.has(account.id) || (!account.weekly && !account.fiveHour)) continue;
      latest.set(account.id, { sample: account, t });
    }
  }
  return latest;
}

const STATUS_REJECTED = 'rejected';

export function resolveAccountStatus(
  file: AuthFileItem,
  quota: ResolvedAccountQuota,
  nowMs: number
): AccountStatus {
  const { weekly, fiveHour } = quota;
  if (weekly && (weekly.used >= 100 || weekly.status === STATUS_REJECTED)) {
    return { kind: 'weekly_exhausted', untilMs: weekly.resetAtMs };
  }
  if (fiveHour && (fiveHour.used >= 100 || fiveHour.status === STATUS_REJECTED)) {
    return { kind: 'five_hour_blocked', untilMs: fiveHour.resetAtMs };
  }
  const records = file.cooldownSnapshot?.records ?? [];
  const cooldownUntil = records
    .filter((record) => record.scope === 'credential')
    .map((record) => parseTimestampMs(record.retryAt))
    .filter((at) => Number.isFinite(at) && at > nowMs)
    .reduce<number | null>((latest, at) => (latest === null || at > latest ? at : latest), null);
  if (cooldownUntil !== null) return { kind: 'cooldown', untilMs: cooldownUntil };
  const status = typeof file.status === 'string' ? file.status.trim().toLowerCase() : '';
  if (file.unavailable === true || status === 'error') {
    return { kind: 'unavailable', untilMs: null };
  }
  if (!weekly && !fiveHour) return { kind: 'no_data', untilMs: null };
  return { kind: 'available', untilMs: null };
}

export function buildPoolAccounts(sources: PoolSources, nowMs: number): PoolAccount[] {
  const latestHistory = latestHistoryById(sources.history);
  const pacerByIndex = new Map<string, QuotaReading>();
  const pacerById = new Map<string, QuotaReading>();
  for (const account of sources.seatPacer?.accounts ?? []) {
    const reading = readSeatPacerAccount(account);
    if (!reading) continue;
    if (account.authIndex) pacerByIndex.set(account.authIndex, reading);
    if (account.authId) pacerById.set(account.authId, reading);
  }

  return sources.files.map(({ file, type }) => {
    const authIndex = normalizeAuthIndex(file.authIndex);
    const readings: QuotaReading[] = [];
    const signals = readCredentialSignals(type, file.quotaSignals);
    if (signals) readings.push(signals);
    if (type === 'claude') {
      const fileId = typeof file.id === 'string' ? file.id : undefined;
      const pacer =
        (authIndex ? pacerByIndex.get(authIndex) : undefined) ??
        pacerById.get(file.name) ??
        (fileId ? pacerById.get(fileId) : undefined);
      if (pacer) readings.push(pacer);
    }
    const recorded = authIndex ? latestHistory.get(authIndex) : undefined;
    if (recorded) {
      const reading = readHistoryAccount(recorded.sample, recorded.t);
      if (reading) readings.push(reading);
    }
    const quota = resolveAccountQuota(readings, nowMs);
    return {
      key: authIndex ?? file.name,
      authIndex,
      provider: type,
      file,
      quota,
      status: resolveAccountStatus(file, quota, nowMs),
    };
  });
}

export const hasQuotaData = (account: PoolAccount) =>
  account.quota.weekly !== null || account.quota.fiveHour !== null;

/** Accounts that take part in a pool: a known weekly window and a join key. */
export function toSimulationAccounts(accounts: readonly PoolAccount[]): SimulationAccount[] {
  return accounts.flatMap((account) =>
    account.quota.weekly
      ? [
          {
            id: account.key,
            used: account.quota.weekly.used,
            resetAtMs: account.quota.weekly.resetAtMs,
            periodMs: account.quota.weekly.periodMs,
          },
        ]
      : []
  );
}

/* ------------------------------------------------------------------------ */
/* Display identity                                                         */
/* ------------------------------------------------------------------------ */

const EMAIL_PATTERN = /[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+/g;

const maskPart = (value: string) =>
  value.length <= 1 ? '•' : `${value[0]}${'•'.repeat(Math.min(6, value.length - 1))}`;

/** `alice@example.com` → `a•••••@e••••••.com`. The real address never reaches the DOM. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return maskPart(email);
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${maskPart(local)}@${maskPart(host)}${tld}`;
}

export interface AccountLabel {
  text: string;
  /** True when an email was hidden; the UI blurs the masked text. */
  masked: boolean;
}

export function accountLabel(file: AuthFileItem, showEmails: boolean): AccountLabel {
  const base = file.email?.trim() || file.label?.trim() || file.name;
  if (showEmails) return { text: base, masked: false };
  let masked = false;
  const text = base.replace(EMAIL_PATTERN, (match) => {
    masked = true;
    return maskEmail(match);
  });
  return { text, masked };
}

const EMAIL_SHAPE = /^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/;

/** Short name for tight spots (chart labels, stats): an email's local part. */
export function accountShortLabel(file: AuthFileItem, showEmails: boolean): AccountLabel {
  const base = file.email?.trim() || file.label?.trim() || file.name;
  if (!EMAIL_SHAPE.test(base)) return accountLabel(file, showEmails);
  const local = base.slice(0, base.lastIndexOf('@'));
  return showEmails ? { text: local, masked: false } : { text: maskPart(local), masked: true };
}
