import { useTranslation } from 'react-i18next';
import { IconEye, IconEyeOff, IconRefreshCw } from '@/components/ui/icons';
import { useCountUp } from '@/hooks/motion';
import styles from './QuotaHeader.module.scss';

export type QuotaHeaderProps = {
  totalCount: number;
  loadedCount: number;
  attentionCount: number;
  refreshing: boolean;
  disableControls: boolean;
  showEmails: boolean;
  onShowEmailsChange: (value: boolean) => void;
  /** Reloads hub-cached data only; never queries providers. */
  onRefresh: () => void;
};

/**
 * 额度页头部：标题领衔 + ▍mono 遥测 meta 行 + 动作区。
 * 与凭证库头部同语汇（无 eyebrow —— ▍游标挂在 meta 行开头）。
 *
 * 入场：三处 `data-reveal` 交给页面壳的 useRevealGroup 统一编排
 * （标题 0ms → meta 70ms → 动作 140ms → tabs 210ms）。
 */
export function QuotaHeader(props: QuotaHeaderProps) {
  const {
    totalCount,
    loadedCount,
    attentionCount,
    refreshing,
    disableControls,
    showEmails,
    onShowEmailsChange,
    onRefresh,
  } = props;
  const { t } = useTranslation();
  // 数据陆续落地时，「已加载」是页面上唯一滚动的数字
  const displayLoadedCount = useCountUp(loadedCount);

  return (
    <header className={styles.header}>
      <div className={styles.copy}>
        <h1 className={styles.title} data-reveal>
          {t('quota_management.title')}
        </h1>
        <p className={styles.meta} data-reveal>
          <span className={styles.metaTotal}>
            {t('quota_management.meta_credentials', { count: totalCount })}
          </span>
          <span className={styles.metaDot} aria-hidden="true">
            ·
          </span>
          <span className={loadedCount > 0 ? styles.metaLoaded : styles.metaMuted}>
            {t('quota_management.meta_loaded', { count: displayLoadedCount })}
          </span>
          {attentionCount > 0 && (
            <>
              <span className={styles.metaDot} aria-hidden="true">
                ·
              </span>
              <span className={styles.metaAttention}>
                {t('quota_management.meta_attention', { count: attentionCount })}
              </span>
            </>
          )}
        </p>
      </div>
      <div className={styles.actions} data-reveal>
        <button
          type="button"
          className={styles.secondaryAction}
          aria-pressed={showEmails}
          onClick={() => onShowEmailsChange(!showEmails)}
        >
          {showEmails ? (
            <IconEyeOff size={14} aria-hidden="true" />
          ) : (
            <IconEye size={14} aria-hidden="true" />
          )}
          {t('quota_management.show_emails')}
        </button>
        <button
          type="button"
          className={styles.primaryAction}
          onClick={onRefresh}
          disabled={disableControls || refreshing}
          title={t('quota_management.refresh_hub_hint')}
        >
          <IconRefreshCw
            size={14}
            aria-hidden="true"
            className={refreshing ? styles.spinning : undefined}
          />
          {t('quota_management.refresh_hub')}
        </button>
      </div>
    </header>
  );
}
