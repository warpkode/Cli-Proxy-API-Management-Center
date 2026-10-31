/**
 * Reset grants (Claude) and reset credits (Codex) the hub's scheduler holds:
 * when each expires, how it will be spent, and controls to change the policy or
 * spend one now. The scheduler does the spending; this card only reads its
 * state file and sends it commands (see services/api/quotaResets.ts).
 */

import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/Select';
import type { ResolvedTheme } from '@/types';
import {
  QuotaResetsServiceError,
  RESET_POLICIES,
  grantKey,
  quotaResetsApi,
  type QuotaResetsState,
  type ResetGrant,
  type ResetPolicy,
} from '@/services/api/quotaResets';
import { useNotificationStore } from '@/stores';
import { getAuthFileIcon, getTypeLabel } from '@/features/authFiles/constants';
import { accountLabel, accountShortLabel, type PoolAccount } from '../pool/accounts';
import { durationParts, formatInstant, formatPercent } from '../pool/format';
import type { GrantOutcome } from '../pool/poolModel';
import styles from './ResetsCard.module.scss';

/** The scheduler file is rewritten at least this often while it runs. */
const STALE_AFTER_MS = 15 * 60 * 1000;
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVITY_ROWS = 8;
const SPENT_RESULTS = new Set(['reset', 'already_used', 'already_redeemed']);

export interface ResetsCardProps {
  resets: QuotaResetsState;
  accounts: readonly PoolAccount[];
  /** Projected outcome per pending grant (from the pool projections). */
  outcomes: Record<string, GrantOutcome>;
  nowMs: number;
  showEmails: boolean;
  resolvedTheme: ResolvedTheme;
  canAct: boolean;
  onState: (state: QuotaResetsState | null) => void;
}

export function ResetsCard(props: ResetsCardProps) {
  const { resets, accounts, outcomes, nowMs, showEmails, resolvedTheme, canAct, onState } = props;
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const headingId = useId();
  const defaultLabelId = useId();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const [busy, setBusy] = useState<string | null>(null);

  const minutes = Math.round(resets.leadMs / 60_000);
  const when = (ms: number) => formatInstant(ms, nowMs, locale);
  const countdown = (ms: number) => {
    const { days, hours, minutes: mins } = durationParts(ms - nowMs);
    const duration =
      days > 0
        ? t('quota_management.pool_duration_dh', { days, hours })
        : hours > 0
          ? t('quota_management.pool_duration_hm', { hours, minutes: mins })
          : t('quota_management.pool_duration_m', { minutes: Math.max(1, mins) });
    return t('quota_management.pool_in_duration', { duration });
  };
  const policyLabel = (policy: ResetPolicy) =>
    t(`quota_management.resets_policy_${policy}`, { minutes });
  const resultLabel = (code: string) =>
    t(`quota_management.resets_result_${code}`, { defaultValue: code.replace(/_/g, ' ') });

  const byKey = useMemo(
    () => new Map(accounts.map((account) => [account.key, account])),
    [accounts]
  );
  const nameOf = (accountId: string) => {
    const account = byKey.get(accountId);
    return account ? accountLabel(account.file, showEmails) : { text: accountId, masked: false };
  };
  const shortNameOf = (accountId: string) => {
    const account = byKey.get(accountId);
    return account ? accountShortLabel(account.file, showEmails).text : accountId;
  };

  const pending = resets.grants
    .filter(
      (grant) =>
        grant.state === 'pending' &&
        grant.left > 0 &&
        (grant.expiresAtMs === null || grant.expiresAtMs > nowMs)
    )
    .sort(
      (left, right) =>
        (left.expiresAtMs ?? Number.POSITIVE_INFINITY) -
        (right.expiresAtMs ?? Number.POSITIVE_INFINITY)
    );
  const recent = resets.grants
    .filter((grant) => !pending.includes(grant))
    .filter((grant) => (grant.last?.atMs ?? grant.expiresAtMs ?? 0) > nowMs - RECENT_MS)
    .sort((left, right) => (right.last?.atMs ?? 0) - (left.last?.atMs ?? 0));

  const clearsLabel = (grant: ResetGrant) => {
    if (grant.provider === 'codex') return t('quota_management.resets_clears_codex');
    const weekly = grant.clears.some((window) => window.startsWith('seven_day'));
    const fiveHour = grant.clears.includes('five_hour');
    if (weekly && fiveHour) return t('quota_management.resets_clears_both');
    if (fiveHour) return t('quota_management.resets_clears_five_hour');
    return t('quota_management.resets_clears_weekly');
  };

  const planLine = (grant: ResetGrant) => {
    const outcome = outcomes[grantKey(grant)];
    const name = shortNameOf(grant.accountId);
    if (grant.policy === 'off') return t('quota_management.resets_plan_off');
    if (!outcome) return '';
    if (outcome.kind === 'spent') {
      const amount = `${formatPercent(outcome.amount)}`;
      if (grant.policy === 'limit') {
        return t('quota_management.resets_plan_limit_spend', {
          name,
          time: when(outcome.atMs),
          amount,
        });
      }
      return grant.requiresLimit
        ? t('quota_management.resets_plan_spend_claude', { name, time: when(outcome.atMs), amount })
        : t('quota_management.resets_plan_spend', { time: when(outcome.atMs), amount });
    }
    if (outcome.reason === 'not_limited' && outcome.atMs !== null) {
      return t('quota_management.resets_plan_not_limited', { name, time: when(outcome.atMs) });
    }
    if (grant.policy === 'limit') return t('quota_management.resets_plan_limit_none', { name });
    return t('quota_management.resets_plan_unknown');
  };

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try {
      await action();
    } catch (error) {
      const message =
        error instanceof QuotaResetsServiceError && error.code
          ? resultLabel(error.code)
          : error instanceof Error
            ? error.message
            : String(error);
      showNotification(t('quota_management.resets_action_failed', { message }), 'error');
    } finally {
      setBusy(null);
    }
  };

  const changePolicy = (grant: ResetGrant, policy: ResetPolicy) => {
    if (policy === grant.policy) return;
    void run(grantKey(grant), async () => onState(await quotaResetsApi.setPolicy(grant, policy)));
  };

  const changeDefault = (value: string) => {
    const policy = RESET_POLICIES.find((item) => item === value);
    if (!policy || policy === resets.defaultPolicy) return;
    void run('default', async () => onState(await quotaResetsApi.setDefaultPolicy(policy)));
  };

  const spendNow = (grant: ResetGrant) => {
    const name = nameOf(grant.accountId).text;
    showConfirmation({
      title: t('quota_management.resets_use_confirm_title'),
      message: t(
        grant.requiresLimit
          ? 'quota_management.resets_use_confirm_claude'
          : 'quota_management.resets_use_confirm_codex',
        { name }
      ),
      confirmText: t('quota_management.resets_use_now'),
      variant: 'primary',
      onConfirm: () =>
        run(grantKey(grant), async () => {
          const { result, state } = await quotaResetsApi.spend(grant);
          onState(state);
          if (SPENT_RESULTS.has(result)) {
            showNotification(t('quota_management.resets_spend_done', { name }), 'success');
          } else {
            showNotification(
              t('quota_management.resets_spend_refused', { result: resultLabel(result) }),
              'warning'
            );
          }
        }),
    });
  };

  const checkNow = () =>
    void run('refresh', async () => {
      try {
        onState(await quotaResetsApi.refresh());
      } catch (error) {
        if (error instanceof QuotaResetsServiceError && error.status === 429) {
          showNotification(
            t('quota_management.resets_check_wait', {
              seconds: Math.ceil(error.retryAfterSeconds ?? 60),
            }),
            'info'
          );
          return;
        }
        throw error;
      }
    });

  const providerIcon = (provider: string) => {
    const src = getAuthFileIcon(provider, resolvedTheme);
    return src ? (
      <img src={src} alt="" className={styles.icon} />
    ) : (
      <span className={styles.icon}>{getTypeLabel(t, provider).slice(0, 1)}</span>
    );
  };

  const lastChecked = resets.accounts.reduce<number | null>(
    (latest, account) =>
      account.checkedAtMs !== null && (latest === null || account.checkedAtMs > latest)
        ? account.checkedAtMs
        : latest,
    null
  );
  const stale = resets.updatedMs !== null && nowMs - resets.updatedMs > STALE_AFTER_MS;
  const failing = resets.accounts.filter((account) => account.error);

  return (
    <section className={styles.card} aria-labelledby={headingId}>
      <header className={styles.head}>
        <h2 id={headingId} className={styles.title}>
          <span className={styles.glyph} aria-hidden="true">
            ⟲
          </span>
          {t('quota_management.resets_title')}
          <span className={styles.subtitle}>
            {t(`quota_management.resets_subtitle_${resets.defaultPolicy}`, { minutes })}
          </span>
        </h2>
        <div className={styles.defaultPolicy}>
          <span id={defaultLabelId} className={styles.defaultLabel}>
            {t('quota_management.resets_default_label')}
          </span>
          <Select
            value={resets.defaultPolicy}
            options={RESET_POLICIES.map((policy) => ({
              value: policy,
              label: policyLabel(policy),
            }))}
            onChange={changeDefault}
            ariaLabelledBy={defaultLabelId}
            disabled={!canAct || busy !== null}
            size="sm"
            fullWidth={false}
          />
        </div>
      </header>

      {stale && resets.updatedMs !== null && (
        <p className={styles.warning} role="status">
          {t('quota_management.resets_stale', { time: when(resets.updatedMs) })}
        </p>
      )}

      {pending.length === 0 ? (
        <p className={styles.none}>{t('quota_management.resets_none')}</p>
      ) : (
        <ul className={styles.rows}>
          {pending.map((grant) => {
            const name = nameOf(grant.accountId);
            const disabled = !canAct || busy !== null;
            const plan = planLine(grant);
            return (
              <li key={grantKey(grant)} className={styles.row}>
                <div className={styles.what}>
                  <div className={styles.who}>
                    <span aria-hidden="true">{providerIcon(grant.provider)}</span>
                    <span
                      className={name.masked ? styles.masked : styles.name}
                      title={name.masked ? undefined : name.text}
                    >
                      {name.text}
                    </span>
                    <span className={styles.tag} title={grant.label || undefined}>
                      {clearsLabel(grant)}
                    </span>
                    {grant.left > 1 && (
                      <span className={styles.tag}>
                        {t('quota_management.resets_left', { count: grant.left })}
                      </span>
                    )}
                  </div>
                  <div className={styles.expires}>
                    {grant.expiresAtMs !== null ? (
                      <>
                        {t('quota_management.resets_expires', { time: when(grant.expiresAtMs) })} ·{' '}
                        <span className={styles.countdown}>{countdown(grant.expiresAtMs)}</span>
                      </>
                    ) : (
                      t('quota_management.resets_no_expiry')
                    )}
                  </div>
                </div>
                <div className={styles.actions}>
                  <div
                    className={styles.segmented}
                    role="group"
                    aria-label={t('quota_management.resets_policy_group', { name: name.text })}
                  >
                    {RESET_POLICIES.map((policy) => (
                      <button
                        key={policy}
                        type="button"
                        aria-pressed={grant.policy === policy}
                        disabled={disabled}
                        onClick={() => changePolicy(grant, policy)}
                      >
                        {policyLabel(policy)}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className={styles.useNow}
                    disabled={disabled}
                    onClick={() => spendNow(grant)}
                  >
                    {t('quota_management.resets_use_now')}
                  </button>
                </div>
                {(plan || grant.last) && (
                  <p className={styles.plan}>
                    {plan}
                    {grant.last && (
                      <>
                        {plan && ' · '}
                        {t('quota_management.resets_last', {
                          time: when(grant.last.atMs),
                          result: resultLabel(grant.last.result),
                        })}
                      </>
                    )}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {recent.length > 0 && (
        <ul className={styles.recent} aria-label={t('quota_management.resets_recent')}>
          {recent.map((grant) => {
            const name = nameOf(grant.accountId);
            const at = grant.last?.atMs ?? grant.expiresAtMs;
            const stateKey =
              grant.state === 'spent' || grant.state === 'expired' || grant.state === 'failed'
                ? grant.state
                : 'failed';
            return (
              <li key={grantKey(grant)}>
                <span aria-hidden="true">{providerIcon(grant.provider)}</span>
                <span className={name.masked ? styles.masked : styles.name}>{name.text}</span>
                <span>
                  {grant.state === 'off'
                    ? t('quota_management.resets_policy_off')
                    : at !== null
                      ? t(`quota_management.resets_state_${stateKey}`, { time: when(at) })
                      : ''}
                  {grant.last && ` · ${resultLabel(grant.last.result)}`}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {failing.length > 0 && (
        <ul className={styles.errors}>
          {failing.map((account) => (
            <li key={account.id}>
              {t('quota_management.resets_account_error', {
                name: nameOf(account.id).masked ? shortNameOf(account.id) : nameOf(account.id).text,
                error: resultLabel(account.error ?? 'error'),
                time: account.nextCheckAtMs !== null ? when(account.nextCheckAtMs) : '—',
              })}
            </li>
          ))}
        </ul>
      )}

      <footer className={styles.footer}>
        <span>
          {lastChecked !== null
            ? t('quota_management.resets_checked', { time: when(lastChecked) })
            : t('quota_management.resets_not_checked')}
        </span>
        <button
          type="button"
          className={styles.textButton}
          onClick={checkNow}
          disabled={!canAct || busy !== null}
        >
          {t('quota_management.resets_check_now')}
        </button>
        <details className={styles.activity}>
          <summary>{t('quota_management.resets_activity')}</summary>
          {resets.log.length === 0 ? (
            <p>{t('quota_management.resets_activity_empty')}</p>
          ) : (
            <ol>
              {resets.log.slice(0, ACTIVITY_ROWS).map((entry) => (
                <li key={`${entry.atMs}-${entry.grantId}-${entry.result}`}>
                  <span className={styles.logTime}>{when(entry.atMs)}</span>
                  <span>{shortNameOf(entry.accountId)}</span>
                  <span>
                    {t(`quota_management.resets_trigger_${entry.trigger}`, {
                      defaultValue: entry.trigger,
                    })}
                  </span>
                  <span className={SPENT_RESULTS.has(entry.result) ? styles.ok : undefined}>
                    {resultLabel(entry.result)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </details>
      </footer>
    </section>
  );
}
