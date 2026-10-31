/**
 * One provider's pooled quota: hero remaining, the four projection stats, the
 * chart, and (in Accounts mode) per-account lines plus a table.
 *
 * Layout only; numbers come from buildPoolView (pool/poolView.ts).
 */

import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResolvedTheme } from '@/types';
import { TYPE_COLORS } from '@/utils/quota';
import { getAuthFileIcon, getTypeLabel } from '@/features/authFiles/constants';
import { accountLabel, type PoolAccount } from '../pool/accounts';
import {
  durationParts,
  formatInstant,
  formatPercent,
  formatRate,
  formatShortDate,
} from '../pool/format';
import type { BurnWindowHours, FutureUsageMode, TimeRange } from '../pool/poolModel';
import { buildPoolView, niceCeiling } from '../pool/poolView';
import { DEFAULT_HISTORY_INTERVAL_MS } from '../pool/history';
import type { PoolProvider, QuotaHistory } from '../pool/types';
import type { PoolMetric } from '../uiState';
import { PoolAccountsTable } from './PoolAccountsTable';
import { PoolChart, type PoolChartAccountLine } from './PoolChart';
import styles from './PoolCard.module.scss';

/** Drawing budget per series. */
const MAX_POINTS = 720;
/** Categorical slots available for per-account lines (never cycled). */
const SERIES_SLOTS = 8;

export interface PoolCardProps {
  provider: PoolProvider;
  accounts: readonly PoolAccount[];
  history: QuotaHistory | null;
  nowMs: number;
  range: TimeRange;
  metric: PoolMetric;
  burnWindow: BurnWindowHours;
  futureUsage: FutureUsageMode;
  showAccounts: boolean;
  showEmails: boolean;
  resolvedTheme: ResolvedTheme;
  initialChartWidth?: number;
}

export function PoolCard(props: PoolCardProps) {
  const {
    provider,
    accounts,
    history,
    nowMs,
    range,
    metric,
    burnWindow,
    futureUsage,
    showAccounts,
    showEmails,
    resolvedTheme,
    initialChartWidth,
  } = props;
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const headingId = useId();
  const providerLabel = getTypeLabel(t, provider);
  const iconSrc = getAuthFileIcon(provider, resolvedTheme);
  const colorSet = TYPE_COLORS[provider] ?? TYPE_COLORS.unknown;
  const color = (resolvedTheme === 'dark' && colorSet.dark ? colorSet.dark : colorSet.light).text;

  const view = useMemo(
    () =>
      buildPoolView({
        accounts,
        history,
        nowMs,
        range,
        burnWindowHours: burnWindow,
        futureUsage,
        maxPoints: MAX_POINTS,
      }),
    [accounts, history, nowMs, range, burnWindow, futureUsage]
  );
  const { summary, burn, members } = view;

  // Account colors follow the account (its position in the provider's list),
  // so toggling modes or filters never repaints a survivor.
  const colors = useMemo(() => {
    const map = new Map<string, string>();
    members.forEach((member, index) => {
      if (index < SERIES_SLOTS) map.set(member.key, `var(--viz-series-${index + 1})`);
    });
    return map;
  }, [members]);

  const labelFor = (key: string) => {
    const account = accounts.find((item) => item.key === key);
    return account ? accountLabel(account.file, showEmails) : { text: key, masked: false };
  };

  const accountLines: PoolChartAccountLine[] =
    showAccounts && metric === 'remaining'
      ? view.remaining.accounts.flatMap((series) => {
          const lineColor = colors.get(series.key);
          if (!lineColor) return [];
          const label = labelFor(series.key);
          return [{ ...series, color: lineColor, label: label.text, masked: label.masked }];
        })
      : [];

  const intervalMs = history?.intervalMs ?? DEFAULT_HISTORY_INTERVAL_MS;
  const bucketMs = (range.endMs - range.startMs) / (MAX_POINTS / 2 - 1);
  const maxGapMs = Math.max(3 * intervalMs, 2.5 * bucketMs);

  const formatDuration = (ms: number) => {
    const { days, hours, minutes } = durationParts(ms);
    if (days > 0) return t('quota_management.pool_duration_dh', { days, hours });
    if (hours > 0) return t('quota_management.pool_duration_hm', { hours, minutes });
    return t('quota_management.pool_duration_m', { minutes: Math.max(1, minutes) });
  };
  const notBy = t('quota_management.pool_not_by', {
    date: formatShortDate(summary.horizonEndMs, locale),
  });

  const firstEmptyLabel = summary.firstEmpty ? labelFor(summary.firstEmpty.accountId) : null;
  const plans = Array.from(
    new Set(members.map((member) => member.quota.plan).filter((plan): plan is string => !!plan))
  );

  const drainMax = niceCeiling(
    Math.max(1, view.projectedBurnPerHour, ...view.drain.recorded.map((point) => point.value))
  );

  return (
    <section className={styles.card} aria-labelledby={headingId} data-provider={provider}>
      <header className={styles.head}>
        <span className={styles.iconWrap} aria-hidden="true">
          {iconSrc ? (
            <img src={iconSrc} alt="" className={styles.icon} />
          ) : (
            <span className={styles.iconFallback}>{providerLabel.slice(0, 1)}</span>
          )}
        </span>
        <h2 id={headingId} className={styles.title}>
          {providerLabel}
        </h2>
        <span className={styles.count}>
          {t('quota_management.pool_accounts_count', { count: accounts.length })}
        </span>
      </header>

      <div className={styles.summary}>
        <p className={styles.hero}>
          <span className={styles.heroValue}>{formatPercent(summary.remaining)}</span>
          <span className={styles.heroOf}>
            {t('quota_management.pool_of_capacity', {
              capacity: formatPercent(summary.capacity),
            })}
          </span>
          {plans.length === 1 && <span className={styles.planChip}>{plans[0]}</span>}
        </p>

        <dl className={styles.stats}>
          <div className={styles.stat}>
            <dt>{t('quota_management.pool_stat_pool_empty')}</dt>
            <dd>
              {summary.poolEmptyAtMs !== null
                ? summary.poolEmptyAtMs <= nowMs
                  ? t('quota_management.pool_empty_now')
                  : formatInstant(summary.poolEmptyAtMs, nowMs, locale)
                : notBy}
            </dd>
          </div>
          <div className={styles.stat}>
            <dt>{t('quota_management.pool_stat_first_empty')}</dt>
            <dd>
              {summary.firstEmpty && firstEmptyLabel ? (
                <>
                  <span
                    className={firstEmptyLabel.masked ? styles.masked : styles.statAccount}
                    title={firstEmptyLabel.masked ? undefined : firstEmptyLabel.text}
                  >
                    {firstEmptyLabel.text}
                  </span>{' '}
                  {summary.firstEmpty.atMs <= nowMs
                    ? t('quota_management.pool_empty_now')
                    : t('quota_management.pool_in_duration', {
                        duration: formatDuration(summary.firstEmpty.atMs - nowMs),
                      })}
                </>
              ) : (
                notBy
              )}
            </dd>
          </div>
          <div className={styles.stat}>
            <dt>{t('quota_management.pool_stat_next_reset')}</dt>
            <dd>
              {summary.nextReset ? (
                <>
                  <strong>+{formatPercent(summary.nextReset.amount)}</strong>{' '}
                  {formatInstant(summary.nextReset.t, nowMs, locale)}
                </>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div className={styles.stat}>
            <dt>{t('quota_management.pool_stat_burn', { hours: burnWindow })}</dt>
            <dd>
              {burn.sufficient ? (
                formatRate(burn.ratePerHour)
              ) : (
                <span className={styles.muted}>
                  {t('quota_management.pool_not_enough_history')}
                </span>
              )}
            </dd>
          </div>
        </dl>
      </div>

      {members.length === 0 ? (
        <p className={styles.empty} role="status">
          {t('quota_management.pool_no_members')}
        </p>
      ) : metric === 'remaining' ? (
        <PoolChart
          range={range}
          nowMs={nowMs}
          yMax={summary.capacity}
          color={color}
          recorded={view.remaining.recorded}
          projected={view.remaining.projected}
          recordedStepUps={view.remaining.recordedStepUps}
          projectedStepUps={view.remaining.projectedStepUps}
          accountLines={accountLines}
          emptyAtMs={summary.poolEmptyAtMs}
          maxGapMs={maxGapMs}
          seriesLabel={t('quota_management.pool_legend_pool')}
          formatTick={formatPercent}
          formatReadout={(value) =>
            t('quota_management.pool_tooltip_left', { value: formatPercent(value) })
          }
          ariaLabel={t('quota_management.pool_chart_label', {
            provider: providerLabel,
            remaining: formatPercent(summary.remaining),
            capacity: formatPercent(summary.capacity),
          })}
          initialWidth={initialChartWidth}
        />
      ) : (
        <PoolChart
          range={range}
          nowMs={nowMs}
          yMax={drainMax}
          color={color}
          recorded={view.drain.recorded}
          projected={view.drain.projected}
          maxGapMs={maxGapMs}
          seriesLabel={t('quota_management.pool_legend_burn')}
          formatTick={(value) => formatRate(value)}
          formatReadout={formatRate}
          ariaLabel={t('quota_management.pool_drain_chart_label', { provider: providerLabel })}
          initialWidth={initialChartWidth}
        />
      )}

      {(!view.hasHistory || view.missing.length > 0) && (
        <ul className={styles.notes}>
          {!view.hasHistory && members.length > 0 && (
            <li>{t('quota_management.pool_no_history')}</li>
          )}
          {view.missing.length > 0 && (
            <li>{t('quota_management.pool_missing_data', { count: view.missing.length })}</li>
          )}
        </ul>
      )}

      {showAccounts && accounts.length > 0 && (
        <PoolAccountsTable
          caption={t('quota_management.pool_table_label', { provider: providerLabel })}
          accounts={accounts}
          colors={colors}
          showEmails={showEmails}
          nowMs={nowMs}
        />
      )}
    </section>
  );
}
