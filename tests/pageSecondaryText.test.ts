// Secondary text on the dashboard, system, logs and plugins pages and the main layout:
// definitions live in InfoTips after their labels, restating subtitles and descriptions are
// gone, and warnings / destructive-action notes stay visible. Static markup and source
// contracts only; hover, focus and tap behaviour and the visual layout need a browser.

import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../src/i18n/index';
import { DashboardPage } from '../src/features/dashboard/DashboardPage';
import { SystemPage } from '../src/pages/SystemPage';

// Injected by Vite at build time; the system page reads it during render.
(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ = '0.0.0-test';

const initialLanguage = i18n.language;
afterAll(async () => {
  await i18n.changeLanguage(initialLanguage);
});

const renderPage = (component: () => ReturnType<typeof createElement> | null) =>
  renderToStaticMarkup(createElement(MemoryRouter, null, createElement(component)));
const infoTipNames = (html: string) =>
  (html.match(/<button\b[^>]*data-info-tip=""[^>]*>/g) ?? []).map(
    (tag) => tag.match(/aria-label="([^"]*)"/)?.[1]
  );
const read = (path: string) => readFileSync(path, 'utf8');

const stripSvg = (html: string) => html.replace(/<svg\b[\s\S]*?<\/svg>/g, '<svg/>');
// Fork: the dashboard keeps its own design language (see 181c4a9b): the credentials tile
// carries a caption, the fleet card a subtitle and each call-to-action card a description.
// Upstream's InfoTip-only dashboard is intentionally not adopted here.
describe('dashboard (fork design)', () => {
  test('the credentials tile keeps its caption line under the number', async () => {
    await i18n.changeLanguage('en');
    const html = renderPage(DashboardPage);
    expect(html).toContain(i18n.t('dashboard.stats_aria'));
    expect(html).toContain(i18n.t('dashboard.stat_credentials_empty'));
    expect(html).not.toContain('{{');
  });

  test('the fleet card has a subtitle and every call-to-action card a description', async () => {
    await i18n.changeLanguage('en');
    const html = stripSvg(renderPage(DashboardPage));
    expect(html).toContain(i18n.t('dashboard.fleet_description'));
    for (const key of [
      'cta_providers_desc',
      'cta_auth_files_desc',
      'cta_config_desc',
      'cta_quota_desc',
      'cta_logs_desc',
      'cta_system_desc',
    ]) {
      expect(html).toContain(`>${i18n.t(`dashboard.${key}`)}</span>`);
    }
    expect(html).toContain(`>${i18n.t('nav.quota_management')}</span>`);
  });
});

describe('system page', () => {
  test('the models card explains its two buttons in an InfoTip and a tooltip', async () => {
    await i18n.changeLanguage('en');
    const html = renderPage(SystemPage);
    expect(infoTipNames(html)).toEqual([
      `More information about ${i18n.t('system_info.models_title')}`,
    ]);
    expect(html).toContain(`hidden="">${i18n.t('system_info.models_desc')}</span>`);
    // No native titles on the two model buttons: the catalog hint moved into a Tooltip.
    const actions = html.slice(
      html.indexOf(i18n.t('system_info.models_title')),
      html.indexOf(i18n.t('system_info.models_catalog_refresh_button'))
    );
    expect(actions).not.toMatch(/<button[^>]*title=/);
    expect(html).not.toContain(`title="${i18n.t('system_info.models_catalog_refresh_hint')}"`);
    expect(read('src/pages/SystemPage.tsx')).toMatch(
      /<Tooltip content=\{t\('system_info\.models_catalog_refresh_hint'\)\}>\s*<Button/
    );
  });

  test('quick links are titles only; the destructive clear-login note stays visible', async () => {
    await i18n.changeLanguage('en');
    const html = stripSvg(renderPage(SystemPage));
    const quickLinks = html.slice(html.indexOf(i18n.t('system_info.quick_links_title')));
    const cards = quickLinks.match(/<a href="https:[\s\S]*?<\/a>/g) ?? [];
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      // Icon, then a content block holding only the title line.
      expect(card).toMatch(/<div[^>]*><svg\/><\/div><div><div>[^<]+<svg\/><\/div><\/div><\/a>$/);
    }
    // The title row directly precedes the links: no description paragraph between them.
    expect(quickLinks).toMatch(/^[^<]*<\/div><\/div><div><a href=/);
    expect(html).toMatch(new RegExp(`<p[^>]*>${i18n.t('system_info.clear_login_desc')}</p>`));
  });
});

describe('logs page', () => {
  const source = read('src/features/logs/LogsPage.tsx');

  test('the error-log caveat is an InfoTip on the tab card title', () => {
    expect(source).toMatch(
      /\{t\('logs\.error_logs_modal_title'\)\}\s*<InfoTip\s+content=\{t\('logs\.error_logs_description'\)\}/
    );
    expect(source).not.toContain(`<div className="hint">{t('logs.error_logs_description')}</div>`);
    // The "request logging is on, so this list stays empty" warning remains visible.
    expect(source).toContain("{t('logs.error_logs_request_log_enabled')}");
  });

  test('the raw-log explanation moved from a title to an InfoTip beside the switch', () => {
    expect(source).not.toMatch(/title=\{t\('logs\.show_raw_logs_hint'/);
    // A sibling of the switch, not inside its <label>.
    expect(source).toMatch(
      /checked=\{showRawLogs\}[\s\S]*?<\/span>\s*\}\s*\/>\s*<InfoTip\s+content=\{t\('logs\.show_raw_logs_hint'/
    );
  });
});

describe('plugins page and install flow', () => {
  test('the page header is the title alone; warnings stay', () => {
    const page = read('src/features/plugins/PluginsPage.tsx');
    // Only the h1 in the header.
    expect(page).toMatch(
      /<header className=\{styles\.header\}>\s*<h1[^>]*>[^<]*<\/h1>\s*<\/header>/
    );
    expect(page).toContain("t('plugin_management.global_disabled_hint')");
    expect(read('src/features/plugins/components/PluginStoreView.tsx')).toContain(
      "t('plugin_store.security_banner_text')"
    );
  });

  test('install-version options keep only the explanations that change the choice', () => {
    const modal = read('src/features/plugins/components/PluginInstallOptionsModal.tsx');
    // "Choose release" only shows a second line while releases are loading.
    expect(modal).toMatch(
      /'release',\s*t\('plugin_store\.install_version_release_mode'\),[\s\S]*?releaseLoading \? t\('plugin_store\.install_versions_loading'\) : null,/
    );
    expect(modal).toContain("t('plugin_store.install_version_latest_hint'");
    expect(modal).toContain("t('plugin_store.install_version_manual_hint')");
  });

  test('the trust gate keeps every risk statement', () => {
    const gate = read('src/features/plugins/components/PluginInstallGateModal.tsx');
    for (const key of [
      'gate_warning',
      'gate_effect_runs_code',
      'gate_effect_no_review',
      'gate_effect_restart',
      'gate_untrusted_alert',
      'gate_step3_prompt',
    ]) {
      expect(gate).toContain(`t('plugin_store.${key}'`);
    }
    // Step 3 is the prompt, the input and the button; nothing restates the prompt below it.
    expect(gate).toMatch(
      /aria-label=\{t\('plugin_store\.gate_step3_prompt', \{ token \}\)\}\s*\/>\s*<\/div>/
    );
  });
});

describe('main layout', () => {
  // Fork: the sidebar brand shows the full product name next to the mark.
  test('the sidebar brand shows the product name; the full name stays in its title', () => {
    const layout = read('src/components/layout/MainLayout.tsx');
    expect(layout).toMatch(
      /<span className="sidebar-brand-text">\s*<span className="sidebar-brand-title">\{t\('splash\.title'\)\}<\/span>\s*<\/span>/
    );
    expect(layout).toContain('className="sidebar-brand" title={fullBrandName}');
  });
});
