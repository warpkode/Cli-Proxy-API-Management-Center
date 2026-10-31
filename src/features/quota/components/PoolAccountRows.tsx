/**
 * Accounts under a pool chart: which one is serving now, which are drained and
 * when each runs dry or refills. Two lines per account so it reads at any width.
 */

import { useTranslation } from 'react-i18next';
import { grantKey, type ResetGrant } from '@/services/api/quotaResets';
import { accountLabel, type PoolAccount } from '../pool/accounts';
import { durationParts, formatInstant, formatPercent } from '../pool/format';
import type { GrantOutcome } from '../pool/poolModel';
import styles from './PoolAccountRows.module.scss';

export interface PoolAccountRowsProps {
  caption: string;
  accounts: readonly PoolAccount[];
  color: string;
  showEmails: boolean;
  nowMs: number;
  plan: {
    activeId: string | null;
    nextId: string | null;
    emptyAt: Record<string, number | null>;
  };
  grants: readonly ResetGrant[];
  outcomes: Record<string, GrantOutcome>;
}

type RowTone = 'active' | 'empty' | 'held' | 'idle';

interface Row {
  account: PoolAccount;
  remaining: number | null;
  tone: RowTone;
  status: string;
  /** Bold lead word of the status line. */
  lead: string;
  rank: number;
}

export function PoolAccountRows(props: PoolAccountRowsProps) {
  const { caption, accounts, color, showEmails, nowMs, plan, grants, outcomes } = props;
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const when = (ms: number) => formatInstant(ms, nowMs, locale);
  const inDuration = (ms: number) => {
    const { days, hours, minutes } = durationParts(ms - nowMs);
    const duration =
      days > 0
        ? t('quota_management.pool_duration_dh', { days, hours })
        : hours > 0
          ? t('quota_management.pool_duration_hm', { hours, minutes })
          : t('quota_management.pool_duration_m', { minutes: Math.max(1, minutes) });
    return t('quota_management.pool_in_duration', { duration });
  };

  /** The soonest projected grant spend on an account, if any. */
  const plannedSpend = (key: string) =>
    grants
      .filter((grant) => grant.accountId === key)
      .map((grant) => outcomes[grantKey(grant)])
      .filter(
        (outcome): outcome is Extract<GrantOutcome, { kind: 'spent' }> =>
          outcome?.kind === 'spent' && outcome.atMs > nowMs
      )
      .sort((left, right) => left.atMs - right.atMs)[0];

  const rows: Row[] = accounts.map((account) => {
    const weekly = account.quota.weekly;
    const remaining = weekly ? Math.max(0, 100 - weekly.used) : null;
    const emptyAt = plan.emptyAt[account.key] ?? null;
    const { kind, untilMs } = account.status;
    const spend = plannedSpend(account.key);

    if (remaining === null) {
      return {
        account,
        remaining,
        tone: 'idle',
        lead: t('quota_management.pool_row_no_data'),
        status: '',
        rank: 5,
      };
    }
    if (remaining <= 0 || kind === 'weekly_exhausted') {
      const refill =
        spend && (weekly?.resetAtMs === null || spend.atMs < (weekly?.resetAtMs ?? Infinity))
          ? t('quota_management.pool_row_reset_planned', { time: when(spend.atMs) })
          : weekly?.resetAtMs
            ? t('quota_management.pool_row_refills', { time: when(weekly.resetAtMs) })
            : '';
      return {
        account,
        remaining: 0,
        tone: 'empty',
        lead: t('quota_management.pool_row_empty'),
        status: refill,
        rank: 1,
      };
    }
    if (kind === 'five_hour_blocked' || kind === 'cooldown') {
      return {
        account,
        remaining,
        tone: 'held',
        lead: t(
          kind === 'cooldown'
            ? 'quota_management.pool_row_cooldown'
            : 'quota_management.pool_row_five_hour'
        ),
        status: untilMs ? t('quota_management.pool_row_back', { time: when(untilMs) }) : '',
        rank: 2,
      };
    }
    if (kind === 'unavailable') {
      return {
        account,
        remaining,
        tone: 'held',
        lead: t('quota_management.pool_status_unavailable'),
        status: '',
        rank: 4,
      };
    }
    if (account.key === plan.activeId) {
      return {
        account,
        remaining,
        tone: 'active',
        lead: t('quota_management.pool_row_in_use'),
        status:
          emptyAt !== null
            ? t('quota_management.pool_row_empties', { time: inDuration(emptyAt) })
            : t('quota_management.pool_row_lasts'),
        rank: 0,
      };
    }
    return {
      account,
      remaining,
      tone: 'idle',
      lead:
        account.key === plan.nextId
          ? t('quota_management.pool_row_up_next')
          : t('quota_management.pool_row_waiting'),
      status:
        emptyAt !== null ? t('quota_management.pool_row_empties', { time: when(emptyAt) }) : '',
      rank: account.key === plan.nextId ? 3 : 3.5,
    };
  });
  rows.sort((left, right) => left.rank - right.rank);

  return (
    <ul className={styles.rows} aria-label={caption}>
      {rows.map(({ account, remaining, tone, lead, status }) => {
        const label = accountLabel(account.file, showEmails);
        const weeklyReset = account.quota.weekly?.resetAtMs ?? null;
        const open = grants.filter((grant) => grant.accountId === account.key).length;
        return (
          <li key={account.key} className={styles.row} data-tone={tone}>
            <span className={styles.name}>
              <span
                className={styles.dot}
                style={tone === 'active' ? { background: color } : undefined}
                aria-hidden="true"
              />
              <span
                className={label.masked ? styles.masked : styles.label}
                title={label.masked ? undefined : label.text}
              >
                {label.text}
              </span>
            </span>
            <span className={styles.meterCell}>
              <span className={styles.value}>
                {remaining === null ? '—' : formatPercent(remaining)}
              </span>
              <span
                className={styles.meter}
                role="meter"
                aria-label={t('quota_management.pool_row_meter', { name: label.text })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(remaining ?? 0)}
              >
                <span
                  className={styles.fill}
                  style={{ width: `${remaining ?? 0}%`, background: color }}
                />
              </span>
            </span>
            <span className={styles.status}>
              <strong>{lead}</strong>
              {status && <> · {status}</>}
            </span>
            <span className={styles.extra}>
              {weeklyReset !== null &&
                t('quota_management.pool_resets', { time: when(weeklyReset) })}
              {open > 0 && (
                <span className={styles.grants}>
                  {weeklyReset !== null && ' · '}⟲{' '}
                  {t('quota_management.pool_row_grants', { count: open })}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
