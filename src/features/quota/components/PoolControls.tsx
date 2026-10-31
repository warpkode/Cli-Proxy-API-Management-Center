import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronLeft } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import {
  BURN_WINDOWS_HOURS,
  FUTURE_USAGE_FACTORS,
  type BurnWindowHours,
  type FutureUsageMode,
} from '../pool/poolModel';
import { POOL_METRICS, type PoolMetric } from '../uiState';
import styles from './PoolControls.module.scss';

export interface PoolControlsProps {
  metric: PoolMetric;
  onMetricChange: (metric: PoolMetric) => void;
  burnWindow: BurnWindowHours;
  onBurnWindowChange: (hours: BurnWindowHours) => void;
  futureUsage: FutureUsageMode;
  onFutureUsageChange: (mode: FutureUsageMode) => void;
  showAccounts: boolean;
  onShowAccountsChange: (value: boolean) => void;
  rangeLabel: string;
  rangeOffset: number;
  onRangeOffsetChange: (offset: number) => void;
}

const FUTURE_USAGE_MODES = Object.keys(FUTURE_USAGE_FACTORS) as FutureUsageMode[];

/** One filter row above the pool cards; every card re-renders against it. */
export function PoolControls(props: PoolControlsProps) {
  const {
    metric,
    onMetricChange,
    burnWindow,
    onBurnWindowChange,
    futureUsage,
    onFutureUsageChange,
    showAccounts,
    onShowAccountsChange,
    rangeLabel,
    rangeOffset,
    onRangeOffsetChange,
  } = props;
  const { t } = useTranslation();
  const burnLabelId = useId();
  const futureLabelId = useId();

  const futureOptions = useMemo(
    () =>
      FUTURE_USAGE_MODES.map((mode) => ({
        value: mode,
        label: t(`quota_management.pool_future_${mode}`),
      })),
    [t]
  );

  return (
    <div
      className={styles.controls}
      role="group"
      aria-label={t('quota_management.pool_controls_label')}
    >
      <div className={styles.group}>
        <div
          className={styles.segmented}
          role="group"
          aria-label={t('quota_management.pool_metric_label')}
        >
          {POOL_METRICS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={metric === value}
              onClick={() => onMetricChange(value)}
            >
              {t(`quota_management.pool_metric_${value}`)}
            </button>
          ))}
        </div>

        <span id={burnLabelId} className={styles.label}>
          {t('quota_management.pool_burn_window_label')}
        </span>
        <div className={styles.segmented} role="group" aria-labelledby={burnLabelId}>
          {BURN_WINDOWS_HOURS.map((hours) => (
            <button
              key={hours}
              type="button"
              aria-pressed={burnWindow === hours}
              onClick={() => onBurnWindowChange(hours)}
            >
              {t('quota_management.pool_burn_window_option', { hours })}
            </button>
          ))}
        </div>

        <span id={futureLabelId} className={styles.label}>
          {t('quota_management.pool_future_label')}
        </span>
        <div className={styles.select}>
          <Select
            value={futureUsage}
            options={futureOptions}
            onChange={(value) => onFutureUsageChange(value as FutureUsageMode)}
            ariaLabelledBy={futureLabelId}
            size="sm"
            fullWidth={false}
          />
        </div>

        <button
          type="button"
          className={styles.toggle}
          aria-pressed={showAccounts}
          onClick={() => onShowAccountsChange(!showAccounts)}
        >
          {t('quota_management.pool_accounts_toggle')}
        </button>
      </div>

      <div className={styles.range}>
        <span className={styles.rangeLabel} aria-live="polite">
          {rangeLabel}
        </span>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => onRangeOffsetChange(rangeOffset - 1)}
          aria-label={t('quota_management.pool_range_prev')}
          title={t('quota_management.pool_range_prev')}
        >
          <IconChevronLeft size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.today}
          onClick={() => onRangeOffsetChange(0)}
          disabled={rangeOffset === 0}
        >
          {t('quota_management.pool_range_today')}
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => onRangeOffsetChange(rangeOffset + 1)}
          aria-label={t('quota_management.pool_range_next')}
          title={t('quota_management.pool_range_next')}
        >
          <IconChevronLeft size={16} aria-hidden="true" className={styles.flip} />
        </button>
      </div>
    </div>
  );
}
