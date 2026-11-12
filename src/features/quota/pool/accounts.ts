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
import {
  FABLE_WEEKLY_SHARE,
  scopeCapacity,
  scopedWindow,
  scopeLeft,
  type HistoryAccountSample,
  type PoolScope,
  type QuotaHistory,
  type QuotaReading,
  type ResolvedAccountQuota,
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
      if (latest.has(account.id)) continue;
      if (!account.weekly && !account.fiveHour && !account.fable) continue;
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

/** Weekly quota left: 0 while the account is at its weekly limit, null when unknown. */
export function weeklyLeft(account: PoolAccount): number | null {
  const weekly = account.quota.weekly;
  if (!weekly) return null;
  if (account.status.kind === 'weekly_exhausted') return 0;
  return Math.max(0, 100 - weekly.used);
}

/**
 * The Fable allowance an account has not used, in percent of its weekly limit
 * (at most FABLE_WEEKLY_SHARE of it); null without a Fable window.
 */
export function fableAllowanceLeft(account: PoolAccount): number | null {
  const fable = account.quota.fable;
  if (!fable) return null;
  if (fable.status === STATUS_REJECTED) return 0;
  return Math.max(0, scopeLeft('fable', fable.used, null));
}

/**
 * What a scope has left on an account, in percent of its weekly limit; null
 * when the account does not report the scope's window. Fable use counts against
 * the weekly limit too, so Fable has the smaller of its allowance and the weekly
 * quota left: an account at its weekly limit has none, whatever its Fable meter says.
 */
export function accountRemaining(account: PoolAccount, scope: PoolScope): number | null {
  if (scope === 'all') {
    const weekly = account.quota.weekly;
    return weekly ? Math.max(0, 100 - weekly.used) : null;
  }
  const allowance = fableAllowanceLeft(account);
  if (allowance === null) return null;
  const weekly = weeklyLeft(account);
  return weekly === null ? allowance : Math.min(allowance, weekly);
}

/** Weekly usage an account has spent on Fable: what a Fable reset gives back. */
function fableSpend(account: PoolAccount): number {
  const fable = account.quota.fable;
  if (!fable) return 0;
  const spend = FABLE_WEEKLY_SHARE * fable.used;
  return account.quota.weekly ? Math.min(spend, account.quota.weekly.used) : spend;
}

/** Accounts that take part in a pool: a known window for the scope and a join key. */
export function toSimulationAccounts(
  accounts: readonly PoolAccount[],
  scope: PoolScope = 'all'
): SimulationAccount[] {
  return accounts.flatMap((account) => {
    const window = scopedWindow(account.quota, scope);
    if (!window) return [];
    const base = { id: account.key, resetAtMs: window.resetAtMs, periodMs: window.periodMs };
    if (scope === 'all') {
      const spend = fableSpend(account);
      return [{ ...base, used: window.used, ...(spend > 0 ? { fableSpend: spend } : {}) }];
    }
    const capacity = scopeCapacity(scope);
    const ceiling = weeklyLeft(account);
    return [
      {
        ...base,
        used: capacity - (fableAllowanceLeft(account) ?? 0),
        capacity,
        ...(ceiling !== null ? { ceiling } : {}),
      },
    ];
  });
}

/** What a scope has left across the accounts that report its window. */
export function poolRemaining(accounts: readonly PoolAccount[], scope: PoolScope): number {
  return accounts.reduce((sum, account) => sum + (accountRemaining(account, scope) ?? 0), 0);
}

/** True when any account reports the scope's window, so the scope has a pool to show. */
export const hasScopeData = (accounts: readonly PoolAccount[], scope: PoolScope) =>
  accounts.some((account) => scopedWindow(account.quota, scope) !== null);

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
