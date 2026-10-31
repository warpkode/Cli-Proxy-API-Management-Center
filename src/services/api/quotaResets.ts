/**
 * Hub-side reset scheduler (fork: hub/quota-service/resets.py on the hub host).
 *
 * Reads: the scheduler publishes its state as `resets.json` next to the quota
 * history, served same-origin, so the page reads it with a plain `fetch` like
 * history.json. It holds auth indexes, grant ids, expiries and policies only.
 *
 * Writes: the scheduler listens on the hub host's loopback only. Policy changes
 * and "use now" go through the management API's `requests/api-call`, which
 * forwards the request to that loopback address; the scheduler checks the same
 * management key again.
 */

import { normalizeAuthIndex } from '@/utils/authIndex';
import { isRecord } from '@/utils/helpers';
import { useAuthStore } from '@/stores/useAuthStore';
import { apiCallApi } from './apiCall';

export const QUOTA_RESETS_URL = '/quota-history/resets.json';
export const QUOTA_RESETS_SERVICE_ORIGIN = 'http://127.0.0.1:8319';
export const QUOTA_RESETS_KEY_HEADER = 'Authorization';

export const RESET_POLICIES = ['expiry', 'limit', 'off'] as const;
export type ResetPolicy = (typeof RESET_POLICIES)[number];

export const isResetPolicy = (value: unknown): value is ResetPolicy =>
  typeof value === 'string' && (RESET_POLICIES as readonly string[]).includes(value);

export type ResetGrantState = 'pending' | 'spent' | 'failed' | 'expired' | 'unknown' | 'off';
const GRANT_STATES = new Set<string>(['pending', 'spent', 'failed', 'expired', 'unknown', 'off']);

export interface ResetAttempt {
  atMs: number;
  trigger: string;
  result: string;
  detail: string;
}

export interface ResetGrant {
  id: string;
  accountId: string;
  provider: string;
  label: string;
  /** Usage windows the grant clears (Claude), e.g. `seven_day`. Empty for Codex. */
  clears: string[];
  startsAtMs: number | null;
  expiresAtMs: number | null;
  left: number;
  total: number;
  usable: boolean | null;
  requiresLimit: boolean;
  policy: ResetPolicy;
  /** True when the grant has its own policy rather than the default. */
  policySet: boolean;
  nextActionAtMs: number | null;
  state: ResetGrantState;
  last: ResetAttempt | null;
}

export interface ResetAccount {
  id: string;
  provider: string;
  checkedAtMs: number | null;
  nextCheckAtMs: number | null;
  error: string | null;
  eligible: boolean | null;
  atLimit: boolean | null;
  limited: boolean | null;
  cooldownUntilMs: number | null;
}

export interface ResetLogEntry {
  atMs: number;
  grantId: string;
  accountId: string;
  provider: string;
  trigger: string;
  result: string;
  detail: string;
}

export interface QuotaResetsState {
  updatedMs: number | null;
  startedMs: number | null;
  leadMs: number;
  defaultPolicy: ResetPolicy;
  accounts: ResetAccount[];
  grants: ResetGrant[];
  log: ResetLogEntry[];
}

const DEFAULT_LEAD_MS = 10 * 60 * 1000;
const TEXT_LIMIT = 120;

const epochMs = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : null;

const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

const count = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;

/** Short display text from the scheduler: control characters stripped, bounded. */
const text = (value: unknown): string =>
  typeof value === 'string'
    ? value
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, TEXT_LIMIT)
    : '';

const provider = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

const readAttempt = (value: unknown): ResetAttempt | null => {
  if (!isRecord(value)) return null;
  const atMs = epochMs(value.t);
  if (atMs === null) return null;
  return {
    atMs,
    trigger: text(value.trigger),
    result: text(value.result),
    detail: text(value.detail),
  };
};

const readGrant = (value: unknown, defaultPolicy: ResetPolicy): ResetGrant | null => {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const accountId = normalizeAuthIndex(value.account);
  if (!id || !accountId) return null;
  const total = count(value.total, 1);
  const state = typeof value.state === 'string' && GRANT_STATES.has(value.state) ? value.state : '';
  return {
    id,
    accountId,
    provider: provider(value.p),
    label: text(value.label),
    clears: Array.isArray(value.clears)
      ? value.clears.filter((item): item is string => typeof item === 'string').map(text)
      : [],
    startsAtMs: epochMs(value.starts),
    expiresAtMs: epochMs(value.expires),
    left: count(value.left, 0),
    total,
    usable: bool(value.usable),
    requiresLimit: value.requires_limit !== false,
    policy: isResetPolicy(value.policy) ? value.policy : defaultPolicy,
    policySet: value.policy_set === true,
    nextActionAtMs: epochMs(value.next_action),
    state: (state || 'pending') as ResetGrantState,
    last: readAttempt(value.last),
  };
};

const readAccount = (value: unknown): ResetAccount | null => {
  if (!isRecord(value)) return null;
  const id = normalizeAuthIndex(value.id);
  if (!id) return null;
  return {
    id,
    provider: provider(value.p),
    checkedAtMs: epochMs(value.checked),
    nextCheckAtMs: epochMs(value.next_check),
    error: typeof value.error === 'string' && value.error ? text(value.error) : null,
    eligible: bool(value.eligible),
    atLimit: bool(value.at_limit),
    limited: bool(value.limited),
    cooldownUntilMs: epochMs(value.cooldown_until),
  };
};

const readLogEntry = (value: unknown): ResetLogEntry | null => {
  if (!isRecord(value)) return null;
  const atMs = epochMs(value.t);
  if (atMs === null) return null;
  return {
    atMs,
    grantId: text(value.grant),
    accountId: normalizeAuthIndex(value.account) ?? '',
    provider: provider(value.p),
    trigger: text(value.trigger),
    result: text(value.result),
    detail: text(value.detail),
  };
};

/** `resets.json` / `GET /state`, normalized. Null for anything else (e.g. an SPA page). */
export function normalizeQuotaResetsState(payload: unknown): QuotaResetsState | null {
  if (!isRecord(payload) || payload.version !== 1) return null;
  const service = isRecord(payload.service) ? payload.service : {};
  const defaultPolicy = isResetPolicy(service.default_policy) ? service.default_policy : 'expiry';
  const leadSeconds = Number(service.lead_seconds);
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  return {
    updatedMs: epochMs(payload.updated),
    startedMs: epochMs(service.started),
    leadMs: Number.isFinite(leadSeconds) && leadSeconds >= 0 ? leadSeconds * 1000 : DEFAULT_LEAD_MS,
    defaultPolicy,
    accounts: list(payload.accounts)
      .map(readAccount)
      .filter((item): item is ResetAccount => item !== null),
    grants: list(payload.grants)
      .map((item) => readGrant(item, defaultPolicy))
      .filter((item): item is ResetGrant => item !== null),
    log: list(payload.log)
      .map(readLogEntry)
      .filter((item): item is ResetLogEntry => item !== null)
      .sort((left, right) => right.atMs - left.atMs),
  };
}

export type ResetsFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Null when the scheduler is not installed (404 or not its JSON); throws on other failures. */
export async function fetchQuotaResetsState(
  fetchImpl: ResetsFetch = (input, init) => fetch(input, init),
  signal?: AbortSignal
): Promise<QuotaResetsState | null> {
  const response = await fetchImpl(QUOTA_RESETS_URL, {
    cache: 'no-cache',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  try {
    return normalizeQuotaResetsState(await response.json());
  } catch {
    return null;
  }
}

/** A refusal from the scheduler, carrying its short error code when it sent one. */
export class QuotaResetsServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds: number | null = null
  ) {
    super(code ? `Reset scheduler: ${code}` : `Reset scheduler HTTP ${status}`);
    this.name = 'QuotaResetsServiceError';
  }
}

export interface SpendResult {
  result: string;
  state: QuotaResetsState | null;
}

async function callService(path: string, body: Record<string, unknown> | null) {
  const key = useAuthStore.getState().managementKey;
  const response = await apiCallApi.request(
    {
      method: body ? 'POST' : 'GET',
      url: `${QUOTA_RESETS_SERVICE_ORIGIN}${path}`,
      header: {
        [QUOTA_RESETS_KEY_HEADER]: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { data: JSON.stringify(body) } : {}),
    },
    // Spends preflight upstream before claiming; the Claude claim alone allows 25 s.
    { timeout: 60_000 }
  );
  const payload = isRecord(response.body) ? response.body : {};
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const retryAfter = Number(payload.retry_after);
    throw new QuotaResetsServiceError(
      response.statusCode,
      text(payload.error ?? payload.result),
      Number.isFinite(retryAfter) ? retryAfter : null
    );
  }
  return payload;
}

export const quotaResetsApi = {
  state: async () => normalizeQuotaResetsState(await callService('/state', null)),
  setPolicy: async (grantId: string, policy: ResetPolicy | 'default') =>
    normalizeQuotaResetsState(await callService('/policy', { grant: grantId, policy })),
  setDefaultPolicy: async (policy: ResetPolicy) =>
    normalizeQuotaResetsState(await callService('/policy', { default_policy: policy })),
  spend: async (grantId: string): Promise<SpendResult> => {
    const payload = await callService('/spend', { grant: grantId });
    return { result: text(payload.result), state: normalizeQuotaResetsState(payload.state) };
  },
  refresh: async () => normalizeQuotaResetsState(await callService('/refresh', {})),
};
