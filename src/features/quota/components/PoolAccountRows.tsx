/**
 * Accounts under a pool chart: which one is serving now, which are drained and
 * when each runs dry or refills. Two lines per account so it reads at any width.
 */

import { useTranslation } from 'react-i18next';
import { grantKey, type ResetGrant } from '@/services/api/quotaResets';
import {
  accountLabel,
  accountRemaining,
  fableAllowanceLeft,
  type PoolAccount,
} from '../pool/accounts';
import { durationParts, formatInstant, formatPercent } from '../pool/format';
import type { GrantOutcome } from '../pool/poolModel';
import { scopeCapacity, scopedWindow, type PoolScope } from '../pool/types';
import styles from './PoolAccountRows.module.scss';

export interface PoolAccountRowsProps {
  caption: string;
  accounts: readonly PoolAccount[];
  /** What each row's figure, meter and status describe. */
  scope?: PoolScope;
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
  /** Fable: the weekly limit, not the Fable allowance, sets what is left. */
  capped?: boolean;
  tone: RowTone;
  status: string;
  /** Bold lead word of the status line. */
  lead: string;
  rank: number;
}

export function PoolAccountRows(props: PoolAccountRowsProps) {
  const { caption, accounts, color, showEmails, nowMs, plan, grants, outcomes } = props;
  const scope = props.scope ?? 'all';
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

  const capacity = scopeCapacity(scope);

  const rows: Row[] = accounts.map((account) => {
    const window = scopedWindow(account.quota, scope);
    const remaining = accountRemaining(account, scope);
    const emptyAt = plan.emptyAt[account.key] ?? null;
    const { kind, untilMs } = account.status;
    const spend = plannedSpend(account.key);
    const allowance = scope === 'fable' ? (fableAllowanceLeft(account) ?? 0) : 0;
    const resetPlanned =
      spend && (window?.resetAtMs === null || spend.atMs < (window?.resetAtMs ?? Infinity))
        ? t('quota_management.pool_row_reset_planned', { time: when(spend.atMs) })
        : '';

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
    if (scope === 'fable' && kind === 'weekly_exhausted' && allowance > 0) {
      // Fable allowance is left, but the weekly limit it draws on is reached.
      return {
        account,
        remaining: 0,
        tone: 'held',
        lead: t('quota_management.pool_row_weekly_limit'),
        status:
          resetPlanned ||
          (untilMs ? t('quota_management.pool_row_back', { time: when(untilMs) }) : ''),
        rank: 2,
      };
    }
    if (remaining <= 0 || (scope === 'all' && kind === 'weekly_exhausted')) {
      return {
        account,
        remaining: 0,
        tone: 'empty',
        lead: t('quota_management.pool_row_empty'),
        status:
          resetPlanned ||
          (window?.resetAtMs
            ? t('quota_management.pool_row_refills', { time: when(window.resetAtMs) })
            : ''),
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
  for (const row of rows) {
    // Less weekly quota left than Fable allowance: the weekly limit is what binds.
    row.capped =
      scope === 'fable' &&
      row.remaining !== null &&
      row.remaining > 0 &&
      (fableAllowanceLeft(row.account) ?? 0) - row.remaining >= 0.5;
  }
  rows.sort((left, right) => left.rank - right.rank);

  return (
    <ul className={styles.rows} aria-label={caption}>
      {rows.map(({ account, remaining, capped, tone, lead, status }) => {
        const label = accountLabel(account.file, showEmails);
        const weeklyReset = scopedWindow(account.quota, scope)?.resetAtMs ?? null;
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
                aria-label={t(
                  scope === 'fable'
                    ? 'quota_management.pool_row_meter_fable'
                    : 'quota_management.pool_row_meter',
                  { name: label.text }
                )}
                aria-valuemin={0}
                aria-valuemax={capacity}
                aria-valuenow={Math.round(remaining ?? 0)}
              >
                <span
                  className={styles.fill}
                  style={{ width: `${((remaining ?? 0) * 100) / capacity}%`, background: color }}
                />
              </span>
            </span>
            <span className={styles.status}>
              <strong>{lead}</strong>
              {status && <> · {status}</>}
            </span>
            <span className={styles.extra}>
              {capped && (
                <>
                  {t('quota_management.pool_row_weekly_capped')}
                  {(weeklyReset !== null || open > 0) && ' · '}
                </>
              )}
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
