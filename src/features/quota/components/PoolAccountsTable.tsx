import { useTranslation } from 'react-i18next';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { formatRelativeInstant } from '@/utils/quota/relativeTime';
import { HOUR_MS } from '@/utils/time/durations';
import { accountLabel, type PoolAccount } from '../pool/accounts';
import { formatInstant, formatPercent } from '../pool/format';
import type { ResolvedWindow } from '../pool/types';
import styles from './PoolCard.module.scss';

export interface PoolAccountsTableProps {
  caption: string;
  accounts: readonly PoolAccount[];
  /** Line color per account key; accounts without a drawn line have none. */
  colors: ReadonlyMap<string, string>;
  showEmails: boolean;
  nowMs: number;
}

/** Older than this, a reading is flagged as stale in the Data column. */
const STALE_AFTER_MS = 6 * HOUR_MS;

export function PoolAccountsTable({
  caption,
  accounts,
  colors,
  showEmails,
  nowMs,
}: PoolAccountsTableProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;

  const windowCell = (window: ResolvedWindow | null) =>
    window ? (
      <>
        <span className={styles.cellValue}>{formatPercent(window.used)}</span>
        {window.resetAtMs !== null && (
          <span className={styles.cellMeta}>
            {t('quota_management.pool_resets', {
              time: formatInstant(window.resetAtMs, nowMs, locale),
            })}
          </span>
        )}
      </>
    ) : (
      <span className={styles.cellMuted}>—</span>
    );

  return (
    <Table className={styles.table} aria-label={caption}>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('quota_management.pool_col_account')}</TableHead>
          <TableHead scope="col">{t('quota_management.pool_col_weekly')}</TableHead>
          <TableHead scope="col">{t('quota_management.pool_col_five_hour')}</TableHead>
          <TableHead scope="col">{t('quota_management.pool_col_status')}</TableHead>
          <TableHead scope="col">{t('quota_management.pool_col_data')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {accounts.map((account) => {
          const label = accountLabel(account.file, showEmails);
          const color = colors.get(account.key);
          const { status, quota } = account;
          const statusText = t(`quota_management.pool_status_${status.kind}`);
          const observedAt = quota.observedAtMs;
          const stale = observedAt !== null && nowMs - observedAt > STALE_AFTER_MS;
          return (
            <TableRow key={account.key}>
              <TableCell>
                <span className={styles.accountCell}>
                  <span
                    className={styles.lineKey}
                    style={color ? { background: color } : undefined}
                    aria-hidden="true"
                  />
                  <span
                    className={label.masked ? styles.masked : styles.accountName}
                    title={label.masked ? undefined : label.text}
                  >
                    {label.text}
                  </span>
                  {quota.plan && <span className={styles.planChip}>{quota.plan}</span>}
                </span>
              </TableCell>
              <TableCell>{windowCell(quota.weekly)}</TableCell>
              <TableCell>{windowCell(quota.fiveHour)}</TableCell>
              <TableCell>
                <span className={styles.status} data-status={status.kind}>
                  {statusText}
                </span>
                {status.untilMs !== null && (
                  <span className={styles.cellMeta}>
                    {t('quota_management.pool_until', {
                      time: formatInstant(status.untilMs, nowMs, locale),
                    })}
                  </span>
                )}
              </TableCell>
              <TableCell>
                {observedAt !== null && quota.source ? (
                  <span className={stale ? styles.stale : styles.cellMeta}>
                    {t('quota_management.pool_observed', {
                      relative: formatRelativeInstant(Math.min(observedAt, nowMs), nowMs, locale),
                      source: t(`quota_management.pool_source_${quota.source.replace('-', '_')}`),
                    })}
                  </span>
                ) : (
                  <span className={styles.cellMuted}>—</span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
