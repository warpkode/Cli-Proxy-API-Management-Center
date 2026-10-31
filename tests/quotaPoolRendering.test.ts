/**
 * Static render of the pooled quota view with hub-shaped fixtures. Covers markup
 * only: hover, keyboard and resize behavior need a browser and are not exercised.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { normalizeAuthFilesResponse } from '@/services/api/authFiles';
import { normalizeSeatPacerStatus } from '@/services/api/seatPacer';
import { classifyQuotaFiles } from '@/features/quota/logic';
import { buildPoolAccounts } from '@/features/quota/pool/accounts';
import { normalizeQuotaHistory } from '@/features/quota/pool/history';
import { poolRange } from '@/features/quota/pool/poolModel';
import type { QuotaHistory } from '@/features/quota/pool/types';
import { PoolCard, type PoolCardProps } from '@/features/quota/components/PoolCard';
import { PoolControls } from '@/features/quota/components/PoolControls';
import { QuotaHeader } from '@/features/quota/components/QuotaHeader';
import { credentialsPayload, historyPayload, NOW, seatPacerPayload } from './fixtures/quotaPool';

const previousLanguage = i18n.language;
beforeAll(async () => {
  await i18n.changeLanguage('en');
});
afterAll(async () => {
  await i18n.changeLanguage(previousLanguage);
});

const history = normalizeQuotaHistory(historyPayload()) as QuotaHistory;
const accounts = buildPoolAccounts(
  {
    files: classifyQuotaFiles(normalizeAuthFilesResponse(credentialsPayload(), NOW).files),
    seatPacer: normalizeSeatPacerStatus(seatPacerPayload()),
    history,
  },
  NOW
);

const cardProps = (overrides: Partial<PoolCardProps> = {}): PoolCardProps => ({
  provider: 'claude',
  accounts: accounts.filter((account) => account.provider === 'claude'),
  history,
  nowMs: NOW,
  range: poolRange(NOW),
  metric: 'remaining',
  burnWindow: 3,
  futureUsage: 'same',
  showAccounts: false,
  showEmails: false,
  resolvedTheme: 'dark',
  initialChartWidth: 1200,
  ...overrides,
});

const render = (overrides: Partial<PoolCardProps> = {}) =>
  renderToStaticMarkup(createElement(PoolCard, cardProps(overrides)));

const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('pool card static render', () => {
  test('renders the pooled hero, the four stats and both chart series', () => {
    const markup = render();
    const plain = text(markup);
    // c1 55 + c2 90 + c3 0 + c4 100 (rolled) = 245 of 400.
    expect(plain).toContain('245%');
    expect(plain).toContain('of 400%');
    expect(plain).toContain('4 accounts');
    expect(plain).toContain('Pool empty');
    expect(plain).toMatch(/Not by \w+ \d+/);
    // c3 is already exhausted: first empty "now".
    expect(plain).toContain('First empty');
    expect(plain).toMatch(/First empty [^ ]+ now/);
    // c3 resets in 20 h with nothing left: +100%.
    expect(plain).toMatch(/Next reset \+100%/);
    // History burns 1%/h (c1) + 0.5%/h (c2).
    expect(plain).toContain('Burn, last 3h 1.5%/h');
    // Chart: solid recorded + dashed projected paths, the Now marker and a legend.
    expect(markup).toContain('<svg');
    // Claude's hue token; solid recorded line, dashed projection, one faded area.
    const lines = markup.match(/<path[^>]*style="stroke:var\(--brand-claude\)"[^>]*>/g) ?? [];
    expect(lines).toHaveLength(2);
    expect(lines.filter((line) => line.includes('stroke-dasharray="6 6"'))).toHaveLength(1);
    expect(markup.match(/<path[^>]*d="M[^"]*Z" fill="url\(#pool-fill-[^"]+\)"/g)).toHaveLength(1);
    // Each step names the account that refills (short names, masked by default).
    expect(plain).toMatch(/\+100% c•+/);
    expect(plain).toContain('Now');
    expect(plain).toContain('Recorded');
    expect(plain).toContain('Projected');
    expect(plain).toContain('+100%');
    expect(markup).toContain('role="group"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('aria-label="Claude pool: 245% of 400% remaining.');
    expect(markup).not.toContain('Not enough history');
  });

  test('emails are masked and blurred by default and never reach the markup', () => {
    const markup = render({ showAccounts: true });
    expect(markup).not.toMatch(/(alpha|bravo|charlie|delta)@example\.com/);
    expect(markup).toContain('a••••@e••••••.com');
    const shown = render({ showAccounts: true, showEmails: true });
    expect(shown).toContain('alpha@example.com');
  });

  test('accounts mode lists what each account is doing, active first', () => {
    const markup = render({ showAccounts: true, showEmails: true });
    const plain = text(markup);
    expect(markup).toContain('aria-label="Claude accounts"');
    expect(markup).not.toContain('<table');
    // c1 resets soonest with quota left, so it serves now; c2 is next; c3 is dry.
    const order = ['alpha', 'charlie', 'bravo', 'delta'].map((name) =>
      plain.indexOf(`${name}@example.com`)
    );
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(plain).toMatch(/alpha@example\.com 55% In use · empties in \d+d \d+h/);
    expect(plain).toMatch(/charlie@example\.com 0% Empty · refills /);
    expect(plain).toMatch(/bravo@example\.com 90% Up next/);
    expect(plain).toMatch(/delta@example\.com 100% Waiting/);
    expect(markup.match(/role="meter"/g)).toHaveLength(4);
  });

  test('drain-rate mode charts %/h', () => {
    const plain = text(render({ metric: 'drain' }));
    expect(plain).toContain('Burn rate');
    expect(plain).toContain('%/h');
  });

  test('without history: projection only and "not enough history"', () => {
    const plain = text(render({ history: null }));
    expect(plain).toContain('Not enough history');
    expect(plain).toContain('No recorded history yet; the chart shows the projection only.');
  });

  test('a single Codex account is one line with its plan', () => {
    const plain = text(
      render({
        provider: 'codex',
        accounts: accounts.filter((account) => account.provider === 'codex'),
      })
    );
    expect(plain).toContain('45%');
    expect(plain).toContain('of 100%');
    expect(plain).toContain('pro');
  });
});

describe('pool controls and header static render', () => {
  test('controls expose pressed states, the future-usage choice and the range', () => {
    const markup = renderToStaticMarkup(
      createElement(PoolControls, {
        metric: 'remaining',
        onMetricChange: () => undefined,
        burnWindow: 3,
        onBurnWindowChange: () => undefined,
        futureUsage: 'same',
        onFutureUsageChange: () => undefined,
        showAccounts: false,
        onShowAccountsChange: () => undefined,
        rangeLabel: 'Oct 19 to Nov 2',
        rangeOffset: 0,
        onRangeOffsetChange: () => undefined,
      })
    );
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Remaining</);
    expect(markup).toMatch(/aria-pressed="false"[^>]*>Drain rate</);
    expect(markup).toMatch(/aria-pressed="true"[^>]*>3h</);
    expect(markup).toMatch(/aria-pressed="false"[^>]*>Accounts</);
    expect(markup).toContain('Same as now');
    expect(markup).toContain('Oct 19 to Nov 2');
    expect(markup).toContain('aria-label="Previous week"');
    expect(markup).toContain('aria-label="Next week"');
    expect(markup).toMatch(/disabled=""[^>]*>Today</);
  });

  test('header shows counts, the email toggle and a hub-only refresh', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaHeader, {
        totalCount: 5,
        loadedCount: 5,
        attentionCount: 1,
        refreshing: false,
        disableControls: false,
        showEmails: false,
        onShowEmailsChange: () => undefined,
        onRefresh: () => undefined,
      })
    );
    const plain = text(markup);
    expect(plain).toContain('Quota Management');
    expect(plain).toContain('5 credentials');
    expect(markup).toMatch(/aria-pressed="false"[^>]*>.*Show emails/);
    expect(markup).toContain('title="Reload hub-cached quota data. Providers are not queried."');
  });
});
