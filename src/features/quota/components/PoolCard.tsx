/**
 * One provider's pooled quota: hero remaining, the projection stats (plus the
 * reset grants waiting on this pool), the chart, and the accounts under it.
 *
 * Claude gets a scope switch in the header once an account reports its Fable
 * limit: the whole weekly limit, or the part of it Fable can still use. Both
 * are in percent of an account's weekly limit, so each segment's figure is
 * comparable and Fable is never the larger; choosing one re-measures the card.
 *
 * Layout only; numbers come from buildPoolView (pool/poolView.ts).
 */

import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResolvedTheme } from '@/types';
import { grantKey, type QuotaResetsState } from '@/services/api/quotaResets';
import { getAuthFileIcon, getTypeLabel } from '@/features/authFiles/constants';
import { accountShortLabel, hasScopeData, poolRemaining, type PoolAccount } from '../pool/accounts';
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
import { poolScopesFor, type PoolProvider, type PoolScope, type QuotaHistory } from '../pool/types';
import type { PoolMetric } from '../uiState';
import { PoolAccountRows } from './PoolAccountRows';
import { PoolChart } from './PoolChart';
import styles from './PoolCard.module.scss';

/** Drawing budget per series. */
const MAX_POINTS = 720;

/** Provider hue for marks; text never takes it. */
const POOL_COLORS: Record<PoolProvider, string> = {
  claude: 'var(--brand-claude)',
  codex: 'var(--brand-codex)',
};

export interface PoolCardProps {
  provider: PoolProvider;
  accounts: readonly PoolAccount[];
  history: QuotaHistory | null;
  resets?: QuotaResetsState | null;
  nowMs: number;
  range: TimeRange;
  metric: PoolMetric;
  burnWindow: BurnWindowHours;
  futureUsage: FutureUsageMode;
  /** Preferred limit to pool; falls back to `all` when this pool cannot show it. */
  scope?: PoolScope;
  /** Enables the scope switch (shown once an account reports a scoped limit). */
  onScopeChange?: (scope: PoolScope) => void;
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
    resets = null,
    nowMs,
    range,
    metric,
    burnWindow,
    futureUsage,
    onScopeChange,
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
  const color = POOL_COLORS[provider];

  // Scopes this pool can show right now: one needs at least one reporting account.
  const scopes = useMemo(
    () =>
      poolScopesFor(provider).filter((value) => value === 'all' || hasScopeData(accounts, value)),
    [provider, accounts]
  );
  const scope: PoolScope = props.scope && scopes.includes(props.scope) ? props.scope : 'all';
  const scoped = scope !== 'all';
  const scopeName = (value: PoolScope) => t(`quota_management.pool_scope_${value}`);
  // "Claude · Fable" wherever the pool is named, so the scope is never implicit.
  const poolLabel = scoped ? `${providerLabel} · ${scopeName(scope)}` : providerLabel;

  const view = useMemo(
    () =>
      buildPoolView({
        accounts,
        history,
        nowMs,
        range,
        burnWindowHours: burnWindow,
        futureUsage,
        scope,
        maxPoints: MAX_POINTS,
        grants: resets?.grants,
        grantLeadMs: resets?.leadMs,
      }),
    [accounts, history, nowMs, range, burnWindow, futureUsage, scope, resets]
  );
  const { summary, burn, members } = view;
  const multi = members.length > 1;

  const shortLabel = (key: string) => {
    const account = accounts.find((item) => item.key === key);
    return account ? accountShortLabel(account.file, showEmails) : { text: key, masked: false };
  };
  const stepNames = (ids: readonly string[]) => {
    const names = ids.slice(0, 2).map((id) => shortLabel(id).text);
    return ids.length > 2 ? `${names.join(', ')} +${ids.length - 2}` : names.join(', ');
  };

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

  const firstEmptyLabel = summary.firstEmpty ? shortLabel(summary.firstEmpty.accountId) : null;
  const plans = Array.from(
    new Set(members.map((member) => member.quota.plan).filter((plan): plan is string => !!plan))
  );

  const pending = view.grants.pending;
  const nextAuto = pending
    .map((grant) => view.grants.outcomes[grantKey(grant)])
    .filter((outcome) => outcome?.kind === 'spent')
    .map((outcome) => outcome.atMs as number)
    .sort((left, right) => left - right)[0];
  const soonestExpiry = pending.find((grant) => grant.expiresAtMs !== null)?.expiresAtMs ?? null;

  const drainMax = niceCeiling(
    Math.max(1, view.projectedBurnPerHour, ...view.drain.recorded.map((point) => point.value))
  );
  const chartHeight = multi ? 300 : 240;

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
        {onScopeChange && scopes.length > 1 && (
          <div
            className={styles.scope}
            role="group"
            aria-label={t('quota_management.pool_scope_label')}
          >
            {scopes.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={scope === value}
                onClick={() => onScopeChange(value)}
              >
                <span>{scopeName(value)}</span>
                <span className={styles.scopeValue}>
                  {formatPercent(poolRemaining(accounts, value))}
                </span>
              </button>
            ))}
          </div>
        )}
      </header>

      <div className={styles.summary}>
        <p className={styles.hero}>
          <span className={styles.heroValue}>{formatPercent(summary.remaining)}</span>
          <span className={styles.heroOf}>
            {t('quota_management.pool_of_capacity', {
              capacity: formatPercent(summary.capacity),
            })}
          </span>
          {scoped && <span className={styles.heroScope}>{scopeName(scope)}</span>}
          {plans.length === 1 && <span className={styles.plan}>{plans[0]}</span>}
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
                  +{formatPercent(summary.nextReset.amount)}{' '}
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
          {pending.length > 0 && (
            <div className={styles.stat}>
              <dt>{t('quota_management.pool_stat_resets')}</dt>
              <dd className={styles.grantStat}>
                ⟲ {pending.length} ·{' '}
                {nextAuto !== undefined
                  ? t('quota_management.pool_resets_auto', {
                      time: formatInstant(nextAuto, nowMs, locale),
                    })
                  : soonestExpiry !== null
                    ? t('quota_management.pool_resets_expires', {
                        time: formatInstant(soonestExpiry, nowMs, locale),
                      })
                    : t('quota_management.pool_resets_kept')}
              </dd>
            </div>
          )}
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
          stepNames={multi ? stepNames : undefined}
          expiryMarkers={view.grants.expiryMarkers.map((marker) => ({
            t: marker.t,
            key: marker.grantKey,
          }))}
          emptyAtMs={summary.poolEmptyAtMs}
          maxGapMs={maxGapMs}
          seriesLabel={t('quota_management.pool_legend_pool')}
          formatTick={formatPercent}
          formatReadout={(value) =>
            t('quota_management.pool_tooltip_left', { value: formatPercent(value) })
          }
          ariaLabel={t('quota_management.pool_chart_label', {
            provider: poolLabel,
            remaining: formatPercent(summary.remaining),
            capacity: formatPercent(summary.capacity),
          })}
          initialWidth={initialChartWidth}
          height={chartHeight}
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
          ariaLabel={t('quota_management.pool_drain_chart_label', { provider: poolLabel })}
          initialWidth={initialChartWidth}
          height={chartHeight}
        />
      )}

      {(scoped || !view.hasHistory || view.missing.length > 0) && (
        <ul className={styles.notes}>
          {scoped && <li>{t(`quota_management.pool_scope_${scope}_note`)}</li>}
          {!view.hasHistory && members.length > 0 && (
            <li>{t('quota_management.pool_no_history')}</li>
          )}
          {view.missing.length > 0 && (
            <li>{t('quota_management.pool_missing_data', { count: view.missing.length })}</li>
          )}
        </ul>
      )}

      {showAccounts && accounts.length > 0 && (
        <PoolAccountRows
          caption={t('quota_management.pool_table_label', { provider: poolLabel })}
          accounts={accounts}
          scope={scope}
          color={color}
          showEmails={showEmails}
          nowMs={nowMs}
          plan={view.plan}
          grants={pending}
          outcomes={view.grants.outcomes}
        />
      )}
    </section>
  );
}
