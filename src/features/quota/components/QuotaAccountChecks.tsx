/**
 * Live account checks: the per-credential quota cards.
 *
 * Every card queries its provider through `POST /v8/management/requests/api-call`,
 * so nothing here runs on its own: a card loads when its Refresh is clicked, and
 * "Check all on this page" is the only batch path. No mount effect, no timer.
 * (The pooled view above reads hub caches instead; see pool/sources.ts.)
 *
 * Preserved contracts: cacheGeneration session isolation and request-id dedupe
 * (useQuotaBatchLoader), per-page batches capped at QUOTA_PAGE_SIZE.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Collapsible } from '@/components/ui/Collapsible';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconSearch, IconX } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { useNow } from '@/hooks/useNow';
import { useQuotaStore } from '@/stores';
import type { ResolvedTheme } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import {
  QUOTA_PAGE_SIZE,
  QUOTA_SORT_MODES,
  type QuotaSortMode,
  type QuotaTabId,
} from '../constants';
import { useQuotaActions } from '../hooks/useQuotaActions';
import { useQuotaBatchLoader } from '../hooks/useQuotaBatchLoader';
import { filterEntriesBySearch, paginate, sortQuotaEntries, type QuotaFileEntry } from '../logic';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import { nextRecoveryMs } from '../resetSchedule';
import { readQuotaUiState, writeQuotaUiState } from '../uiState';
import { QuotaCard } from './QuotaCard';
import { QuotaTimeline } from './QuotaTimeline';
import styles from './QuotaAccountChecks.module.scss';

/**
 * Existing providers display filenames; Devin's card and timeline share an
 * identity-aware display label. Keep the filename fallback stable for memoization.
 */
const displayNameFor = (name: string) => name;

export interface QuotaAccountChecksProps {
  /** Entries for the active provider tab. */
  entries: QuotaFileEntry[];
  tab: QuotaTabId;
  resolvedTheme: ResolvedTheme;
  /** Connected, file list current for this session. */
  canUseActions: boolean;
  /** Collapsible under the pool view; a plain section on tabs without one. */
  collapsible: boolean;
  onShowAllTabs: () => void;
}

export function QuotaAccountChecks(props: QuotaAccountChecksProps) {
  const { entries, tab, resolvedTheme, canUseActions, collapsible, onShowAllTabs } = props;
  const { t } = useTranslation();
  const [open, setOpen] = useState(() => readQuotaUiState()?.checksOpen ?? false);
  const [sortMode, setSortMode] = useState<QuotaSortMode>(
    () => readQuotaUiState()?.sortMode ?? 'default'
  );
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  /* ---------- quota cache (filled only by explicit checks) ---------- */

  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const devinQuota = useQuotaStore((state) => state.devinQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const metaQuota = useQuotaStore((state) => state.metaQuota);
  const pluginQuota = useQuotaStore((state) => state.pluginQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);

  const quotaByType = useMemo<Record<QuotaProviderType, Record<string, QuotaCardState>>>(
    () =>
      ({
        antigravity: antigravityQuota,
        claude: claudeQuota,
        codex: codexQuota,
        devin: devinQuota,
        kimi: kimiQuota,
        meta: metaQuota,
        plugin: pluginQuota,
        xai: xaiQuota,
      }) as unknown as Record<QuotaProviderType, Record<string, QuotaCardState>>,
    [
      antigravityQuota,
      claudeQuota,
      codexQuota,
      devinQuota,
      kimiQuota,
      metaQuota,
      pluginQuota,
      xaiQuota,
    ]
  );

  const getQuota = useCallback(
    (entry: QuotaFileEntry): QuotaCardState | undefined =>
      quotaByType[entry.type][getQuotaCacheKey(entry.file)],
    [quotaByType]
  );

  /* ---------- filter / sort / paginate ---------- */

  // Only the soonest-recovery order needs the minute clock.
  const tick = useNow(sortMode !== 'default');
  const sortNow = sortMode === 'default' ? 0 : tick;

  const filteredEntries = useMemo(() => filterEntriesBySearch(entries, search), [entries, search]);
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);

  const resolveNextRecovery = useCallback(
    (entry: QuotaFileEntry) => nextRecoveryMs(entry.type, getQuota(entry), sortNow),
    [getQuota, sortNow]
  );
  // Sort before paginating, or "soonest" would only hold within a page.
  const sortedEntries = useMemo(
    () => sortQuotaEntries(filteredEntries, sortMode, resolveNextRecovery),
    [filteredEntries, sortMode, resolveNextRecovery]
  );
  const { pageItems, currentPage, totalPages } = useMemo(
    () => paginate(sortedEntries, page, QUOTA_PAGE_SIZE),
    [sortedEntries, page]
  );

  const handleSortModeChange = useCallback((next: string) => {
    setSortMode(next as QuotaSortMode);
    setPage(1);
    writeQuotaUiState({ sortMode: next as QuotaSortMode });
  }, []);

  const sortOptions = useMemo(
    () =>
      QUOTA_SORT_MODES.map((mode) => ({ value: mode, label: t(`quota_management.sort_${mode}`) })),
    [t]
  );

  /* ---------- explicit upstream checks ---------- */

  const { batchLoading, loadQuota } = useQuotaBatchLoader();
  const { resettingQuotaName, refreshQuota, resetQuota } = useQuotaActions(!canUseActions);

  // The only batch path: a click. Never called from an effect or a timer.
  const handleCheckPage = useCallback(() => {
    if (!canUseActions) return;
    void loadQuota(pageItems.filter(({ file }) => !file.disabled));
  }, [canUseActions, loadQuota, pageItems]);

  const checkedCount = useMemo(
    () =>
      entries.filter((entry) => {
        const status = getQuota(entry)?.status;
        return status === 'success' || status === 'error';
      }).length,
    [entries, getQuota]
  );

  const isEmpty = filteredEntries.length === 0;

  const body = (
    <div className={styles.body}>
      <p className={styles.hint}>{t('quota_management.checks_hint')}</p>

      <div className={styles.toolbar}>
        <div className={styles.search}>
          <IconSearch size={16} className={styles.searchIcon} aria-hidden="true" />
          <input
            ref={searchInputRef}
            className={styles.searchInput}
            type="search"
            value={search}
            onChange={(event) => handleSearchChange(event.target.value)}
            placeholder={t('quota_management.search_placeholder')}
            aria-label={t('quota_management.search_label')}
          />
          {search && (
            <button
              type="button"
              className={styles.clearSearch}
              aria-label={t('quota_management.search_clear')}
              title={t('quota_management.search_clear')}
              onClick={() => {
                handleSearchChange('');
                searchInputRef.current?.focus();
              }}
            >
              <IconX size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className={styles.toolbarActions}>
          <div className={styles.sort}>
            <Select
              value={sortMode}
              options={sortOptions}
              onChange={handleSortModeChange}
              ariaLabel={t('quota_management.sort_label')}
              size="sm"
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleCheckPage}
            disabled={!canUseActions || pageItems.length === 0}
            loading={batchLoading}
            title={t('quota_management.checks_refresh_page_hint')}
          >
            {t('quota_management.checks_refresh_page')}
          </Button>
        </div>
      </div>

      {isEmpty ? (
        <EmptyState
          title={
            search.trim()
              ? t('quota_management.search_empty_title')
              : tab === 'all'
                ? t('quota_management.empty_title')
                : t(`${QUOTA_ADAPTERS[tab].i18nPrefix}.empty_title`)
          }
          description={
            search.trim()
              ? t('quota_management.search_empty_desc')
              : tab === 'all'
                ? t('quota_management.empty_desc')
                : t(`${QUOTA_ADAPTERS[tab].i18nPrefix}.empty_desc`)
          }
          action={
            search.trim() ? (
              <Button variant="secondary" size="sm" onClick={() => handleSearchChange('')}>
                {t('quota_management.search_clear')}
              </Button>
            ) : tab === 'all' ? undefined : (
              <Button variant="secondary" size="sm" onClick={onShowAllTabs}>
                {t('auth_files.filter_all')}
              </Button>
            )
          }
        />
      ) : (
        <div className={styles.grid}>
          {pageItems.map((entry) => (
            <QuotaCard
              key={`${entry.type}:${getQuotaCacheKey(entry.file)}`}
              entry={entry}
              quota={getQuota(entry)}
              resolvedTheme={resolvedTheme}
              canRefresh={canUseActions && !entry.file.disabled}
              resetting={resettingQuotaName === getQuotaCacheKey(entry.file)}
              entranceDelayMs={null}
              onRefresh={() => void refreshQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
              onReset={() => resetQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
            />
          ))}
        </div>
      )}

      {filteredEntries.length > QUOTA_PAGE_SIZE && (
        <div className={styles.pagination}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPage(Math.max(1, currentPage - 1))}
            disabled={currentPage <= 1}
          >
            {t('auth_files.pagination_prev')}
          </Button>
          <div className={styles.pageInfo}>
            {t('auth_files.pagination_info', {
              current: currentPage,
              total: totalPages,
              count: filteredEntries.length,
            })}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
            disabled={currentPage >= totalPages}
          >
            {t('auth_files.pagination_next')}
          </Button>
        </div>
      )}

      {/* The windows timeline compares the current page only, keeping lanes bounded. */}
      <QuotaTimeline
        entries={pageItems}
        quotaFor={getQuota}
        displayNameFor={displayNameFor}
        resolvedTheme={resolvedTheme}
      />
    </div>
  );

  const hint = t('quota_management.checks_summary', {
    count: entries.length,
    checked: checkedCount,
  });

  if (!collapsible) {
    return (
      <section className={styles.section} aria-label={t('quota_management.checks_title')}>
        <h2 className={styles.title}>
          {t('quota_management.checks_title')}
          <span className={styles.summary}>{hint}</span>
        </h2>
        {body}
      </section>
    );
  }

  return (
    <Collapsible
      className={styles.collapsible}
      label={t('quota_management.checks_title')}
      hint={hint}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        writeQuotaUiState({ checksOpen: next });
      }}
    >
      {/* Closed: render nothing, so idle cards and the timeline cost nothing. */}
      {open ? body : null}
    </Collapsible>
  );
}
