import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { AxiosError, type AxiosAdapter, type AxiosInstance } from 'axios';
import { apiClient } from '@/services/api/client';
import { normalizeAuthFilesResponse } from '@/services/api/authFiles';
import { normalizeSeatPacerStatus, seatPacerApi } from '@/services/api/seatPacer';
import { classifyQuotaFiles } from '@/features/quota/logic';
import {
  accountLabel,
  buildPoolAccounts,
  maskEmail,
  resolveAccountStatus,
} from '@/features/quota/pool/accounts';
import {
  fetchQuotaHistory,
  normalizeQuotaHistory,
  QUOTA_HISTORY_URL,
} from '@/features/quota/pool/history';
import { readClaudeSignals, readCodexSignals, WEEK_MS } from '@/features/quota/pool/signals';
import {
  loadPoolSources,
  POOL_POLL_INTERVAL_MS,
  shouldReloadHistory,
} from '@/features/quota/pool/sources';
import {
  claudeSignals,
  codexSignals,
  credentialsPayload,
  DAY,
  historyPayload,
  HOUR,
  NOW,
  seatPacerPayload,
} from './fixtures/quotaPool';

const sec = (ms: number) => Math.floor(ms / 1000) * 1000;

describe('credential quota signals', () => {
  test('the credential list normalizes the cached quota block and label', () => {
    const { files } = normalizeAuthFilesResponse(credentialsPayload(), NOW);
    const alpha = files.find((file) => file.authIndex === 'c1');
    expect(alpha?.label).toBe('alpha@example.com');
    expect(alpha?.quotaSignals?.observedAt).toBe(new Date(NOW - 2 * HOUR).toISOString());
    expect(alpha?.quotaSignals?.signals['Anthropic-Ratelimit-Unified-7d-Utilization']).toBe('0.4');
    // account/account_type are never normalized into display fields.
    const codex = files.find((file) => file.authIndex === 'x1');
    expect(codex?.label).toBeUndefined();

    const bare = normalizeAuthFilesResponse({ files: [{ name: 'a.json', quota: 'nope' }] });
    expect(bare.files[0].quotaSignals).toBeUndefined();
    const empty = normalizeAuthFilesResponse({
      files: [{ name: 'a.json', quota: { signals: {} } }],
    });
    expect(empty.files[0].quotaSignals).toBeUndefined();
  });

  test('Claude unified headers become weekly and 5-hour windows (case-insensitive)', () => {
    const reading = readClaudeSignals(claudeSignals(0.4, NOW + 2 * DAY), NOW);
    expect(reading).toMatchObject({
      source: 'signals',
      observedAtMs: NOW,
      weekly: { used: 40, resetAtMs: sec(NOW + 2 * DAY), periodMs: WEEK_MS, status: 'allowed' },
      fiveHour: { used: 20, resetAtMs: sec(NOW + 3 * HOUR), status: 'allowed' },
    });
    const lower = Object.fromEntries(
      Object.entries(claudeSignals(1, NOW + DAY)).map(([key, value]) => [key.toLowerCase(), value])
    );
    expect(readClaudeSignals(lower, null)?.weekly).toMatchObject({ used: 100, status: 'rejected' });
    expect(readClaudeSignals({ 'X-Other': '1' }, null)).toBeNull();
  });

  test('Codex windows are classified by length, not slot', () => {
    // Pro: weekly primary, empty secondary ("0" minutes).
    const pro = readCodexSignals(codexSignals(55, NOW + 3 * DAY), NOW);
    expect(pro).toMatchObject({
      plan: 'pro',
      weekly: { used: 55, resetAtMs: sec(NOW + 3 * DAY), periodMs: WEEK_MS },
      fiveHour: null,
    });
    // Plus-style: 5-hour primary, weekly secondary.
    const plus = readCodexSignals(
      {
        'X-Codex-Primary-Used-Percent': '30',
        'X-Codex-Primary-Window-Minutes': '300',
        'X-Codex-Primary-Reset-At': String((NOW + HOUR) / 1000),
        'X-Codex-Secondary-Used-Percent': '60',
        'X-Codex-Secondary-Window-Minutes': '10080',
        'X-Codex-Secondary-Reset-At': String((NOW + DAY) / 1000),
      },
      NOW
    );
    expect(plus?.weekly).toMatchObject({ used: 60, periodMs: WEEK_MS });
    expect(plus?.fiveHour).toMatchObject({ used: 30, periodMs: 5 * HOUR });
    // No window lengths: a lone primary is the weekly window.
    const bare = readCodexSignals({ 'x-codex-primary-used-percent': '12' }, null);
    expect(bare?.weekly?.used).toBe(12);
  });
});

describe('seat-pacer and history payloads', () => {
  test('seat-pacer status normalizes snapshots and joins by auth_index', () => {
    const status = normalizeSeatPacerStatus(seatPacerPayload());
    expect(status?.pollIntervalSeconds).toBe(120);
    expect(status?.accounts).toHaveLength(2);
    expect(status?.accounts[0]).toMatchObject({
      authId: 'claude-alpha@example.com.json',
      authIndex: 'c1',
      observedAtMs: NOW - 60_000,
      source: 'usage-endpoint',
    });
    expect(status?.accounts[0].windows.map((window) => window.kind)).toEqual([
      'five_hour',
      'seven_day',
      'weekly_scoped',
    ]);
    expect(normalizeSeatPacerStatus('nope')).toBeNull();
  });

  test('history.json converts epoch seconds, sorts samples and rejects other versions', () => {
    const payload = historyPayload(1);
    payload.samples.reverse();
    const history = normalizeQuotaHistory(payload);
    expect(history?.intervalMs).toBe(300_000);
    expect(history?.samples.length).toBe(288);
    expect(history!.samples[0].t).toBeLessThan(history!.samples[1].t);
    expect(history?.samples[0].accounts[0]).toMatchObject({
      id: 'c1',
      provider: 'claude',
      on: true,
      weekly: { used: 20, resetAtMs: sec(NOW + 2 * DAY) },
      src: 'usage',
    });
    expect(normalizeQuotaHistory({ ...payload, version: 2 })).toBeNull();
    expect(normalizeQuotaHistory({ samples: [{ t: 1, a: [{ p: 'claude' }] }] })?.samples).toEqual([
      { t: 1000, accounts: [] },
    ]);
  });

  test('history fetch is same-origin, revalidating, and optional', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const respond = (response: Response) => async (input: string, init?: RequestInit) => {
      calls.push([input, init]);
      return response;
    };
    expect(await fetchQuotaHistory(respond(new Response('', { status: 404 })))).toBeNull();
    expect(calls[0][0]).toBe('/quota-history/history.json');
    expect(calls[0][1]).toMatchObject({ cache: 'no-cache', credentials: 'same-origin' });
    // An SPA fallback page is not history.
    expect(
      await fetchQuotaHistory(respond(new Response('<!doctype html>', { status: 200 })))
    ).toBeNull();
    const ok = await fetchQuotaHistory(
      respond(new Response(JSON.stringify(historyPayload(1)), { status: 200 }))
    );
    expect(ok?.samples.length).toBe(288);
    expect(fetchQuotaHistory(respond(new Response('', { status: 500 })))).rejects.toThrow();
  });
});

describe('pool accounts', () => {
  const sources = () => ({
    files: classifyQuotaFiles(normalizeAuthFilesResponse(credentialsPayload(), NOW).files),
    seatPacer: normalizeSeatPacerStatus(seatPacerPayload()),
    history: normalizeQuotaHistory(historyPayload()),
  });

  test('joins seat-pacer, signals and history per account with freshness rules', () => {
    const accounts = buildPoolAccounts(sources(), NOW);
    const byKey = Object.fromEntries(accounts.map((account) => [account.key, account]));
    // c1: seat-pacer (1 min old) beats signals (2 h old).
    expect(byKey.c1.quota).toMatchObject({ source: 'seat-pacer', weekly: { used: 45 } });
    expect(byKey.c1.quota.fiveHour?.used).toBe(35);
    // c2: signals only among live sources; history is a fallback, not an override.
    expect(byKey.c2.quota).toMatchObject({ source: 'signals', weekly: { used: 10 } });
    // c3: signals (1 h) are fresher than the plugin snapshot (3 h): exhausted.
    expect(byKey.c3.quota.weekly?.used).toBe(100);
    expect(byKey.c3.status).toEqual({ kind: 'weekly_exhausted', untilMs: sec(NOW + 20 * HOUR) });
    // c4: the cached reset passed two days ago; the window reads as fresh.
    expect(byKey.c4.quota.weekly).toMatchObject({
      used: 0,
      rolled: true,
      resetAtMs: sec(NOW - 2 * DAY) + WEEK_MS,
    });
    expect(byKey.c4.status.kind).toBe('available');
    // Codex Pro.
    expect(byKey.x1).toMatchObject({
      provider: 'codex',
      quota: { plan: 'pro', weekly: { used: 55 } },
    });
  });

  test('history is used when no live source reports an account', () => {
    const base = sources();
    const files = base.files.map((entry) =>
      entry.file.authIndex === 'c2'
        ? { ...entry, file: { ...entry.file, quotaSignals: undefined } }
        : entry
    );
    const accounts = buildPoolAccounts({ ...base, files }, NOW);
    const c2 = accounts.find((account) => account.key === 'c2');
    expect(c2?.quota.source).toBe('history');
    expect(c2?.quota.observedAtMs).toBe(sec(NOW - 5 * 60_000));
  });

  test('status order: weekly, 5-hour, cooldown, unavailable, no data', () => {
    const file = { name: 'a.json' };
    const window = (used: number, status?: string) => ({
      used,
      resetAtMs: NOW + HOUR,
      periodMs: WEEK_MS,
      rolled: false,
      ...(status ? { status } : {}),
    });
    const quota = (weekly: number | null, fiveHour: number | null, status?: string) => ({
      weekly: weekly === null ? null : window(weekly),
      fiveHour: fiveHour === null ? null : window(fiveHour, status),
      source: null,
      observedAtMs: null,
    });
    expect(resolveAccountStatus(file, quota(10, 100), NOW).kind).toBe('five_hour_blocked');
    expect(resolveAccountStatus(file, quota(10, 20, 'rejected'), NOW).kind).toBe(
      'five_hour_blocked'
    );
    const cooling = {
      ...file,
      cooldownSnapshot: {
        receivedAtMs: NOW,
        records: [
          {
            scope: 'credential' as const,
            reason: 'credential_quota',
            retryAt: new Date(NOW + 2 * HOUR).toISOString(),
            remainingSeconds: 7200,
          },
          {
            scope: 'model' as const,
            modelKey: 'm',
            reason: 'x',
            retryAt: new Date(NOW + 9 * HOUR).toISOString(),
            remainingSeconds: 32400,
          },
        ],
      },
    };
    expect(resolveAccountStatus(cooling, quota(10, 20), NOW)).toEqual({
      kind: 'cooldown',
      untilMs: NOW + 2 * HOUR,
    });
    expect(resolveAccountStatus({ ...file, status: 'error' }, quota(10, 20), NOW).kind).toBe(
      'unavailable'
    );
    expect(resolveAccountStatus(file, quota(null, null), NOW).kind).toBe('no_data');
    expect(resolveAccountStatus(file, quota(99, 20), NOW).kind).toBe('available');
  });

  test('labels mask emails unless shown, including emails inside file names', () => {
    expect(maskEmail('alice@example.com')).toBe('a••••@e••••••.com');
    const file = { name: 'claude-alice@example.com.json', email: 'alice@example.com' };
    expect(accountLabel(file, false)).toEqual({ text: 'a••••@e••••••.com', masked: true });
    expect(accountLabel(file, true)).toEqual({ text: 'alice@example.com', masked: false });
    const nameOnly = accountLabel({ name: 'claude-bob@example.com.json' }, false);
    expect(nameOnly.masked).toBe(true);
    expect(nameOnly.text).not.toContain('bob@example');
    expect(accountLabel({ name: 'claude-1.json' }, false)).toEqual({
      text: 'claude-1.json',
      masked: false,
    });
  });
});

describe('polling contract: the pool view only reads hub caches', () => {
  const instance = (apiClient as unknown as { instance: AxiosInstance }).instance;
  const originalAdapter = instance.defaults.adapter;
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

  afterEach(() => {
    instance.defaults.adapter = originalAdapter;
    globalThis.fetch = originalFetch;
    apiClient.setConfig({ apiBase: '', managementKey: '' });
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  const installTransport = (seatPacerStatus = 200) => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { dispatchEvent: () => true },
    });
    apiClient.setConfig({
      apiBase: 'https://hub.invalid/v8/management',
      managementKey: 'fixture-only',
    });
    const requests: Array<{ method: string; url: string; auth: unknown }> = [];
    const adapter: AxiosAdapter = async (config) => {
      const url = /^https?:/.test(config.url ?? '')
        ? (config.url as string)
        : `${config.baseURL}${config.url}`;
      requests.push({
        method: String(config.method).toUpperCase(),
        url,
        auth: config.headers.Authorization,
      });
      const status = url.endsWith('/status') ? seatPacerStatus : 200;
      const data = url.endsWith('/credentials') ? credentialsPayload() : seatPacerPayload();
      const response = { data, status, statusText: String(status), headers: {}, config };
      // Real adapters reject non-2xx through validateStatus; mirror that.
      if (status >= 400) {
        throw new AxiosError('Not Found', AxiosError.ERR_BAD_REQUEST, config, null, response);
      }
      return response;
    };
    instance.defaults.adapter = adapter;
    const fetches: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetches.push(String(input));
      return new Response(JSON.stringify(historyPayload(1)), { status: 200 });
    }) as typeof fetch;
    return { requests, fetches };
  };

  test('a load issues exactly the credential list, plugin status and history reads', async () => {
    const { requests, fetches } = installTransport();
    const result = await loadPoolSources({ includeSeatPacer: true, includeHistory: true });
    expect(requests).toEqual([
      {
        method: 'GET',
        url: 'https://hub.invalid/v8/management/credentials',
        auth: 'Bearer fixture-only',
      },
      {
        method: 'GET',
        url: 'https://hub.invalid/v0/management/plugins/claude-seat-pacer/status',
        auth: 'Bearer fixture-only',
      },
    ]);
    expect(fetches).toEqual([QUOTA_HISTORY_URL]);
    expect(requests.some((request) => request.url.includes('api-call'))).toBe(false);
    expect(result.credentials.status).toBe('fulfilled');
    expect(result.seatPacer?.status).toBe('fulfilled');
    expect(result.history?.status).toBe('fulfilled');
  });

  test('without plugin support or a due history reload, only the credential list is read', async () => {
    const { requests, fetches } = installTransport();
    const result = await loadPoolSources({ includeSeatPacer: false, includeHistory: false });
    expect(requests.map((request) => request.url)).toEqual([
      'https://hub.invalid/v8/management/credentials',
    ]);
    expect(fetches).toEqual([]);
    expect(result.seatPacer).toBeNull();
    expect(result.history).toBeNull();
  });

  test('a missing seat-pacer plugin (404) is absent, not an error', async () => {
    installTransport(404);
    expect(await seatPacerApi.status()).toBeNull();
  });

  test('history reloads at most once per recorder interval unless forced', () => {
    expect(shouldReloadHistory(false, null, null, NOW)).toBe(true);
    expect(shouldReloadHistory(false, NOW - POOL_POLL_INTERVAL_MS, 300_000, NOW)).toBe(false);
    expect(shouldReloadHistory(false, NOW - 300_000, 300_000, NOW)).toBe(true);
    expect(shouldReloadHistory(true, NOW, 300_000, NOW)).toBe(true);
  });

  test('page and pool modules never reach the upstream api-call path on their own', () => {
    const poolDir = 'src/features/quota/pool';
    const passive = [
      'src/features/quota/QuotaPage.tsx',
      'src/features/quota/components/QuotaHeader.tsx',
      'src/features/quota/components/PoolCard.tsx',
      'src/features/quota/components/PoolChart.tsx',
      'src/features/quota/components/PoolControls.tsx',
      'src/features/quota/components/PoolAccountsTable.tsx',
      ...readdirSync(poolDir).map((name) => `${poolDir}/${name}`),
    ];
    for (const path of passive) {
      const source = readFileSync(path, 'utf8');
      // Code references only; comments may describe the upstream path.
      for (const forbidden of [
        /apiCallApi/,
        /['"`]\/requests\/api-call/,
        /useQuotaBatchLoader/,
        /\.fetchQuota\(/,
        /\bloadQuota\(/,
      ]) {
        expect({ path, forbidden: String(forbidden), hit: forbidden.test(source) }).toEqual({
          path,
          forbidden: String(forbidden),
          hit: false,
        });
      }
    }
    expect(existsSync('src/features/quota/providers/devin/useDevinQuotaAutoLoad.ts')).toBe(false);

    // Live account checks: no effects at all, and the batch loader runs from one click handler.
    const checks = readFileSync('src/features/quota/components/QuotaAccountChecks.tsx', 'utf8');
    expect(checks).not.toMatch(/\buseEffect\b|\bsetInterval\b|\bsetTimeout\b/);
    expect(checks.match(/loadQuota\(/g)).toHaveLength(1);
    expect(checks).toMatch(/const handleCheckPage = useCallback\(\(\) => \{[^}]*loadQuota\(/);
    expect(checks).toContain('onClick={handleCheckPage}');
  });
});
