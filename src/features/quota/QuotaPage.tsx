/**
 * Quota Management: pooled per-provider view + on-demand live account checks.
 *
 * Polling contract (see pool/sources.ts):
 * - On load and every minute while the tab is visible, the page reads only data
 *   the hub already holds: the credential list (cached rate-limit headers), the
 *   claude-seat-pacer status (when plugins are supported) and the recorded
 *   history file. None of these reaches an upstream provider.
 * - Per-account upstream reads (`requests/api-call`) happen only from explicit
 *   clicks inside "Live account checks". Nothing queries providers on mount or
 *   on a timer.
 *
 * Retained contracts: cacheGeneration session isolation, pruning quota caches
 * to surviving credentials, and this page as the sole header-refresh handler.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { useRevealGroup } from '@/hooks/motion';
import { useAuthStore, useThemeStore } from '@/stores';
import type { ResolvedTheme } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { ProviderTabs } from '@/features/authFiles/components/ProviderTabs';
import { QuotaHeader } from './components/QuotaHeader';
import { QuotaAccountChecks } from './components/QuotaAccountChecks';
import { PoolCard } from './components/PoolCard';
import { PoolControls } from './components/PoolControls';
import { QUOTA_TAB_ORDER, type QuotaTabId } from './constants';
import { buildTabCounts, classifyQuotaFiles, filterEntriesByTab } from './logic';
import { buildPoolAccounts, hasQuotaData, type PoolAccount } from './pool/accounts';
import { formatShortDate } from './pool/format';
import { poolRange, type BurnWindowHours, type FutureUsageMode } from './pool/poolModel';
import { POOL_PROVIDERS, isPoolProvider, type PoolProvider } from './pool/types';
import { usePoolSources, type OptionalSourceState } from './pool/usePoolSources';
import { QUOTA_ADAPTERS, getQuotaSetter } from './providers';
import type { QuotaProviderType } from './providers/types';
import {
  readQuotaUiState,
  readShowEmails,
  writeQuotaUiState,
  writeShowEmails,
  type PoolMetric,
} from './uiState';
import styles from './QuotaPage.module.scss';

const SKELETON_CARD_COUNT = 2;

const sourceStateKey = (state: OptionalSourceState) =>
  state === 'ok' ? 'ok' : state === 'absent' ? 'absent' : state === 'error' ? 'error' : null;

export function QuotaPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const supportsPlugin = useAuthStore((state) => state.supportsPlugin);
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const connected = connectionStatus === 'connected';
  // Header + tabs entrance cascade (title → meta → actions → tabs, 70ms apart).
  const revealRef = useRevealGroup<HTMLDivElement>();

  const [stored] = useState(() => readQuotaUiState());
  const [tab, setTab] = useState<QuotaTabId>(stored?.tab ?? 'all');
  const [metric, setMetric] = useState<PoolMetric>(stored?.metric ?? 'remaining');
  const [burnWindow, setBurnWindow] = useState<BurnWindowHours>(stored?.burnWindow ?? 3);
  const [futureUsage, setFutureUsage] = useState<FutureUsageMode>(stored?.futureUsage ?? 'same');
  const [showAccounts, setShowAccounts] = useState(stored?.showAccounts ?? false);
  const [showEmails, setShowEmails] = useState(readShowEmails);
  const [rangeOffset, setRangeOffset] = useState(0);

  /* ---------- hub-cached sources (no upstream calls) ---------- */

  const sources = usePoolSources({
    connected,
    supportsPlugin,
    errorFallback: t('notification.refresh_failed'),
  });
  const { refresh, sessionGeneration } = sources;
  useHeaderRefresh(refresh);

  const nowMs = useNow();

  const entries = useMemo(() => classifyQuotaFiles(sources.files), [sources.files]);
  const tabCounts = useMemo(() => buildTabCounts(entries), [entries]);
  const visibleTabs = useMemo(
    () => [
      'all',
      ...QUOTA_TAB_ORDER.filter((type) => isPoolProvider(type) || (tabCounts[type] ?? 0) > 0),
    ],
    [tabCounts]
  );
  const activeTab: QuotaTabId = visibleTabs.includes(tab) ? tab : 'all';

  const poolAccounts = useMemo(
    () =>
      buildPoolAccounts(
        { files: entries, seatPacer: sources.seatPacer, history: sources.history },
        nowMs
      ),
    [entries, sources.seatPacer, sources.history, nowMs]
  );
  const accountsByProvider = useMemo(() => {
    const grouped = new Map<PoolProvider, PoolAccount[]>();
    for (const account of poolAccounts) {
      if (!isPoolProvider(account.provider)) continue;
      const list = grouped.get(account.provider) ?? [];
      list.push(account);
      grouped.set(account.provider, list);
    }
    return grouped;
  }, [poolAccounts]);

  const loadedCount = poolAccounts.filter(hasQuotaData).length;
  const attentionCount = poolAccounts.filter(
    (account) => account.status.kind === 'unavailable'
  ).length;

  const shownPools = POOL_PROVIDERS.filter(
    (provider) =>
      (activeTab === 'all' || activeTab === provider) &&
      (accountsByProvider.get(provider)?.length ?? 0) > 0
  );
  const range = useMemo(() => poolRange(nowMs, rangeOffset), [nowMs, rangeOffset]);
  const rangeLabel = t('quota_management.pool_range', {
    start: formatShortDate(range.startMs, locale),
    end: formatShortDate(range.endMs - 1, locale),
  });

  /* ---------- prune per-account caches to surviving credentials ---------- */

  useEffect(() => {
    if (sources.loading || sources.error || sources.filesGeneration !== sessionGeneration) return;
    const survivorsByType = new Map<QuotaProviderType, Set<string>>(
      QUOTA_TAB_ORDER.map((type) => [type, new Set<string>()])
    );
    entries.forEach((entry) => survivorsByType.get(entry.type)?.add(getQuotaCacheKey(entry.file)));

    QUOTA_TAB_ORDER.forEach((type) => {
      const survivors = survivorsByType.get(type) ?? new Set<string>();
      const setQuota = getQuotaSetter(QUOTA_ADAPTERS[type]);
      setQuota((prev) => {
        const staleKeys = Object.keys(prev).filter((name) => !survivors.has(name));
        if (staleKeys.length === 0) return prev;
        const next = { ...prev };
        staleKeys.forEach((name) => delete next[name]);
        return next;
      });
    });
  }, [entries, sessionGeneration, sources.error, sources.filesGeneration, sources.loading]);

  /* ---------- preferences ---------- */

  const handleTabChange = useCallback((next: string) => {
    setTab(next as QuotaTabId);
    writeQuotaUiState({ tab: next as QuotaTabId });
  }, []);
  const handleMetricChange = useCallback((next: PoolMetric) => {
    setMetric(next);
    writeQuotaUiState({ metric: next });
  }, []);
  const handleBurnWindowChange = useCallback((next: BurnWindowHours) => {
    setBurnWindow(next);
    writeQuotaUiState({ burnWindow: next });
  }, []);
  const handleFutureUsageChange = useCallback((next: FutureUsageMode) => {
    setFutureUsage(next);
    writeQuotaUiState({ futureUsage: next });
  }, []);
  const handleShowAccountsChange = useCallback((next: boolean) => {
    setShowAccounts(next);
    writeQuotaUiState({ showAccounts: next });
  }, []);
  const handleShowEmailsChange = useCallback((next: boolean) => {
    setShowEmails(next);
    writeShowEmails(next);
  }, []);

  const canUseActions =
    connected && !sources.loading && sources.filesGeneration === sessionGeneration;
  const tabEntries = useMemo(() => filterEntriesByTab(entries, activeTab), [entries, activeTab]);

  const pacerState = supportsPlugin ? sourceStateKey(sources.seatPacerState) : null;
  const historyState = sourceStateKey(sources.historyState);

  return (
    <div className={styles.page} ref={revealRef}>
      <QuotaHeader
        totalCount={entries.length}
        loadedCount={loadedCount}
        attentionCount={attentionCount}
        refreshing={sources.refreshing}
        disableControls={!connected}
        showEmails={showEmails}
        onShowEmailsChange={handleShowEmailsChange}
        onRefresh={() => void refresh()}
      />

      <section className={styles.workbench}>
        <div className={styles.tabsRow} data-reveal>
          <ProviderTabs
            types={visibleTabs}
            counts={tabCounts}
            active={activeTab}
            resolvedTheme={resolvedTheme}
            onChange={handleTabChange}
          />
        </div>

        {sources.error && (
          <div className={styles.errorBanner} role="alert">
            {sources.error}
          </div>
        )}

        {sources.loading ? (
          <div className={styles.pools} aria-hidden="true">
            {Array.from({ length: SKELETON_CARD_COUNT }, (_, index) => (
              <Skeleton key={index} height={420} rounded={14} />
            ))}
          </div>
        ) : (
          <>
            {shownPools.length > 0 && (
              <>
                <PoolControls
                  metric={metric}
                  onMetricChange={handleMetricChange}
                  burnWindow={burnWindow}
                  onBurnWindowChange={handleBurnWindowChange}
                  futureUsage={futureUsage}
                  onFutureUsageChange={handleFutureUsageChange}
                  showAccounts={showAccounts}
                  onShowAccountsChange={handleShowAccountsChange}
                  rangeLabel={rangeLabel}
                  rangeOffset={rangeOffset}
                  onRangeOffsetChange={setRangeOffset}
                />
                <p className={styles.sourceNote}>
                  <span>{t('quota_management.pool_sources_note')}</span>
                  {pacerState && (
                    <span className={styles.sourceChip} data-state={pacerState}>
                      {t('quota_management.pool_source_status_seat_pacer', {
                        state: t(`quota_management.pool_source_state_${pacerState}`),
                      })}
                    </span>
                  )}
                  {historyState && (
                    <span className={styles.sourceChip} data-state={historyState}>
                      {t('quota_management.pool_source_status_history', {
                        state: t(`quota_management.pool_source_state_${historyState}`),
                      })}
                    </span>
                  )}
                </p>
                <div className={styles.pools}>
                  {shownPools.map((provider) => (
                    <PoolCard
                      key={provider}
                      provider={provider}
                      accounts={accountsByProvider.get(provider) ?? []}
                      history={sources.history}
                      nowMs={nowMs}
                      range={range}
                      metric={metric}
                      burnWindow={burnWindow}
                      futureUsage={futureUsage}
                      showAccounts={showAccounts}
                      showEmails={showEmails}
                      resolvedTheme={resolvedTheme}
                    />
                  ))}
                </div>
              </>
            )}

            <QuotaAccountChecks
              entries={tabEntries}
              tab={activeTab}
              resolvedTheme={resolvedTheme}
              canUseActions={canUseActions}
              collapsible={shownPools.length > 0}
              onShowAllTabs={() => handleTabChange('all')}
            />
          </>
        )}
      </section>
    </div>
  );
}
