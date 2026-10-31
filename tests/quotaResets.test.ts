/**
 * The hub reset scheduler on the quota page: reading its state file, sending it
 * commands through the management API, and the static render of the grants on
 * the pool card and the Resets card. Browser interactions are not exercised.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { apiCallApi } from '@/services/api/apiCall';
import { normalizeAuthFilesResponse } from '@/services/api/authFiles';
import {
  QUOTA_RESETS_SERVICE_ORIGIN,
  QUOTA_RESETS_URL,
  QuotaResetsServiceError,
  fetchQuotaResetsState,
  normalizeQuotaResetsState,
  quotaResetsApi,
  type QuotaResetsState,
} from '@/services/api/quotaResets';
import { normalizeSeatPacerStatus } from '@/services/api/seatPacer';
import { useAuthStore } from '@/stores/useAuthStore';
import { classifyQuotaFiles } from '@/features/quota/logic';
import { buildPoolAccounts } from '@/features/quota/pool/accounts';
import { normalizeQuotaHistory } from '@/features/quota/pool/history';
import { poolRange } from '@/features/quota/pool/poolModel';
import { buildPoolView } from '@/features/quota/pool/poolView';
import type { QuotaHistory } from '@/features/quota/pool/types';
import { PoolCard } from '@/features/quota/components/PoolCard';
import { ResetsCard } from '@/features/quota/components/ResetsCard';
import {
  credentialsPayload,
  DAY,
  historyPayload,
  HOUR,
  NOW,
  resetsPayload,
  seatPacerPayload,
} from './fixtures/quotaPool';

const previousLanguage = i18n.language;
beforeAll(async () => {
  await i18n.changeLanguage('en');
});
afterAll(async () => {
  await i18n.changeLanguage(previousLanguage);
});

const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const resets = normalizeQuotaResetsState(resetsPayload()) as QuotaResetsState;
const history = normalizeQuotaHistory(historyPayload()) as QuotaHistory;
const accounts = buildPoolAccounts(
  {
    files: classifyQuotaFiles(normalizeAuthFilesResponse(credentialsPayload(), NOW).files),
    seatPacer: normalizeSeatPacerStatus(seatPacerPayload()),
    history,
  },
  NOW
);

describe('reset scheduler state file', () => {
  test('normalizes to milliseconds and drops entries without an id or account', () => {
    expect(resets.leadMs).toBe(600_000);
    expect(resets.defaultPolicy).toBe('expiry');
    expect(resets.updatedMs).toBe(NOW - 60_000);
    expect(resets.grants.map((grant) => grant.id)).toEqual([
      'grant_c3',
      'grant_c1',
      'credit_x1',
      'credit_old',
    ]);
    const c3 = resets.grants[0];
    expect(c3).toMatchObject({
      accountId: 'c3',
      provider: 'claude',
      clears: ['seven_day'],
      expiresAtMs: NOW + 6 * HOUR,
      requiresLimit: true,
      policy: 'expiry',
      policySet: false,
      state: 'pending',
      left: 1,
    });
    expect(resets.grants[2]).toMatchObject({ requiresLimit: false, policy: 'limit' });
    expect(resets.grants[3].last).toEqual({
      atMs: NOW - 3 * HOUR,
      trigger: 'expiry',
      result: 'reset',
      detail: '',
    });
    expect(resets.accounts.find((account) => account.id === 'c2')?.error).toBe('rate_limited');
    expect(resets.log).toHaveLength(1);
  });

  test('anything that is not a version 1 scheduler file reads as absent', () => {
    expect(normalizeQuotaResetsState({ ...resetsPayload(), version: 2 })).toBeNull();
    expect(normalizeQuotaResetsState('<!doctype html>')).toBeNull();
    const unknownPolicy = normalizeQuotaResetsState({
      ...resetsPayload(),
      service: { default_policy: 'sometimes' },
    });
    expect(unknownPolicy?.defaultPolicy).toBe('expiry');
    expect(unknownPolicy?.leadMs).toBe(600_000);
  });

  test('fetch reads the same-origin file; 404 or an HTML page means not installed', async () => {
    const calls: string[] = [];
    const respond = (status: number, body: string) => async (input: string) => {
      calls.push(input);
      return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
    };
    expect(await fetchQuotaResetsState(respond(200, JSON.stringify(resetsPayload())))).not.toBe(
      null
    );
    expect(calls[0]).toBe(QUOTA_RESETS_URL);
    expect(await fetchQuotaResetsState(respond(404, ''))).toBeNull();
    expect(await fetchQuotaResetsState(respond(200, '<html></html>'))).toBeNull();
    await expect(fetchQuotaResetsState(respond(502, ''))).rejects.toThrow('HTTP 502');
  });
});

describe('reset scheduler commands', () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
  });
  afterEach(() => {
    useAuthStore.setState({ managementKey: '' });
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  test('go through api-call to the loopback scheduler with the management key', async () => {
    useAuthStore.setState({ managementKey: 'test-key' });
    const spy = spyOn(apiCallApi, 'request').mockResolvedValue({
      statusCode: 200,
      header: {},
      bodyText: '',
      body: { result: 'reset', state: resetsPayload() },
    });
    try {
      const outcome = await quotaResetsApi.spend('grant_c3');
      expect(outcome.result).toBe('reset');
      expect(outcome.state?.grants).toHaveLength(4);
      const [request] = spy.mock.calls[0];
      expect(request).toMatchObject({
        method: 'POST',
        url: `${QUOTA_RESETS_SERVICE_ORIGIN}/spend`,
        data: JSON.stringify({ grant: 'grant_c3' }),
      });
      expect(request.header?.Authorization).toBe('Bearer test-key');
      expect(request.authIndex).toBeUndefined();

      await quotaResetsApi.setPolicy('credit_x1', 'off');
      expect(spy.mock.calls[1][0]).toMatchObject({
        url: `${QUOTA_RESETS_SERVICE_ORIGIN}/policy`,
        data: JSON.stringify({ grant: 'credit_x1', policy: 'off' }),
      });
    } finally {
      spy.mockRestore();
    }
  });

  test('a refusal surfaces the scheduler code and retry hint', async () => {
    const spy = spyOn(apiCallApi, 'request').mockResolvedValue({
      statusCode: 429,
      header: {},
      bodyText: '',
      body: { error: 'too_soon', retry_after: 42 },
    });
    try {
      const failure = await quotaResetsApi.refresh().catch((error) => error);
      expect(failure).toBeInstanceOf(QuotaResetsServiceError);
      expect(failure).toMatchObject({ status: 429, code: 'too_soon', retryAfterSeconds: 42 });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('grants in the pool projection and on the page', () => {
  const claude = accounts.filter((account) => account.provider === 'claude');
  const view = buildPoolView({
    accounts: claude,
    history,
    nowMs: NOW,
    range: poolRange(NOW),
    burnWindowHours: 3,
    futureUsage: 'same',
    grants: resets.grants,
    grantLeadMs: resets.leadMs,
  });

  test('pending grants on the pool feed the projection', () => {
    expect(view.grants.pending.map((grant) => grant.id)).toEqual(['grant_c3', 'grant_c1']);
    // c3 is dry, so Claude accepts its grant ten minutes before expiry.
    expect(view.grants.outcomes.grant_c3).toEqual({
      kind: 'spent',
      atMs: NOW + 6 * HOUR - 600_000,
      amount: 100,
    });
    // c1 still has quota a day from now: refused, and its expiry stays on the chart.
    expect(view.grants.outcomes.grant_c1).toMatchObject({ kind: 'unused', reason: 'not_limited' });
    expect(view.grants.expiryMarkers).toEqual([
      { t: NOW + DAY, grantId: 'grant_c1', accountId: 'c1' },
    ]);
    expect(view.remaining.projectedStepUps).toContainEqual(
      expect.objectContaining({ kind: 'grant', grantId: 'grant_c3', amount: 100 })
    );
  });

  test('the pool card shows the Resets stat, the amber step and the expiry key', () => {
    const markup = renderToStaticMarkup(
      createElement(PoolCard, {
        provider: 'claude',
        accounts: claude,
        history,
        resets,
        nowMs: NOW,
        range: poolRange(NOW),
        metric: 'remaining',
        burnWindow: 3,
        futureUsage: 'same',
        showAccounts: true,
        showEmails: true,
        resolvedTheme: 'dark',
        initialChartWidth: 1200,
      })
    );
    const plain = text(markup);
    expect(plain).toMatch(/Resets ⟲ 2 · auto \w{3} \d/);
    expect(plain).toContain('⟲ +100%');
    expect(plain).toContain('Reset expires');
    expect(plain).toMatch(/charlie@example\.com 0% Empty · reset planned \w{3} /);
    expect(plain).toMatch(/alpha@example\.com.*⟲ 1 reset/);
  });

  test('the Resets card lists each grant with its policy, plan and controls', () => {
    const outcomes = { ...view.grants.outcomes };
    const markup = renderToStaticMarkup(
      createElement(ResetsCard, {
        resets,
        accounts,
        outcomes,
        nowMs: NOW,
        showEmails: true,
        resolvedTheme: 'dark',
        canAct: true,
        onState: () => undefined,
      })
    );
    const plain = text(markup);
    expect(plain).toContain('Resets spent automatically 10 min before they expire');
    // Soonest expiry first; Claude grants name the window they clear.
    const order = ['charlie', 'alpha', 'echo'].map((name) =>
      plain.indexOf(`${name}@example.com Weekly`)
    );
    expect(plain.indexOf('charlie@example.com')).toBeLessThan(plain.indexOf('alpha@example.com'));
    expect(order[0]).toBeGreaterThan(-1);
    expect(plain).toContain('alpha@example.com Weekly + 5-hour');
    expect(plain).toContain('echo@example.com Rate limits');
    expect(plain).toMatch(/Expires \w{3} \d+:\d{2} [AP]M · in 6h 0m/);
    expect(plain).toContain(
      'charlie is projected to be at its limit then, so Claude will accept it'
    );
    expect(plain).toContain(
      'Claude only accepts it while the account is limited; alpha is projected to still have quota then'
    );
    expect(plain).toMatch(/Last attempt \w{3} [^·]+· not at its limit/);
    // One policy group per pending grant, with the current policy pressed.
    expect(markup.match(/role="group"/g)).toHaveLength(3);
    expect(markup.match(/aria-pressed="true"[^>]*>10 min before expiry</g)).toHaveLength(2);
    expect(markup).toMatch(/aria-pressed="true"[^>]*>When limited</);
    expect(markup.match(/>Use now</g)).toHaveLength(3);
    // The spent credit, the account that could not be read, and the activity log.
    expect(plain).toMatch(/echo@example\.com Spent \w{3} [^·]+· reset/);
    expect(plain).toContain('read resets for bravo@example.com (rate limited)');
    expect(plain).toContain('Activity');
  });

  test('hidden emails stay masked in the Resets card', () => {
    const markup = renderToStaticMarkup(
      createElement(ResetsCard, {
        resets,
        accounts,
        outcomes: view.grants.outcomes,
        nowMs: NOW,
        showEmails: false,
        resolvedTheme: 'dark',
        canAct: false,
        onState: () => undefined,
      })
    );
    expect(markup).not.toMatch(/(alpha|bravo|charlie|echo)@example\.com/);
    expect(markup).toContain('disabled=""');
  });
});
