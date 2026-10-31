import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  IconBot,
  IconFileText,
  IconSidebarConfig,
  IconSidebarLogs,
  IconSidebarQuota,
  IconSidebarSystem,
} from '@/components/ui/icons';
import { useAuthStore } from '@/stores';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { formatCompactNumber, formatDateValue, formatPercent } from '@/utils/format';
import { useDashboardOverview } from './hooks/useDashboardOverview';
import { Meter } from './components/Meter';
import { Sparkline } from './components/Sparkline';
import { ThroughputChart } from './components/ThroughputChart';
import { useCountUp, useRevealGroup, useRevealOnScroll } from '@/hooks/motion';
import { providerLabel, splitWindowMinutes, toneForSuccessRate, type MeterTone } from './utils';
import styles from './dashboard.module.scss';

const DASH = '—';

/** KPI 卡左上角色签：有语义色调的卡用状态色，其余保持中性 */
const TILE_ACCENTS: Record<MeterTone, string> = {
  good: 'var(--viz-success)',
  warning: 'var(--amber-color)',
  critical: 'var(--viz-failure)',
  idle: 'var(--text-quaternary)',
};

/** Fleet sparklines take the provider's data accent; everything else stays neutral. */
const FLEET_ACCENTS: Record<string, string> = {
  claude: 'var(--brand-claude)',
  codex: 'var(--brand-codex)',
};

/** 大数字：六位以内用千分位，再往上压缩，避免撑破排版 */
const formatHeadline = (value: number): string =>
  value < 100_000 ? value.toLocaleString() : formatCompactNumber(value);

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const serverVersion = useAuthStore((state) => state.serverVersion);
  const serverBuildDate = useAuthStore((state) => state.serverBuildDate);

  const { connectionStatus, connected, config, counts, traffic, providers, credentials, refresh } =
    useDashboardOverview();

  useHeaderRefresh(refresh, connected);

  /* Hero 与静态网格走分组级联；异步内容区（图表/供应商）保持整块 reveal */
  const heroRef = useRevealGroup<HTMLElement>();
  const statsRef = useRevealGroup<HTMLDListElement>(0.12);
  const trafficRef = useRevealOnScroll<HTMLElement>();
  const fleetRef = useRevealOnScroll<HTMLElement>();
  const detailRef = useRevealGroup<HTMLElement>();
  const ctaRef = useRevealGroup<HTMLElement>();

  const animatedTotal = useCountUp(traffic.total, connected);

  const windowLabel = useMemo(() => {
    if (traffic.windowMinutes <= 0) return DASH;
    const { hours, minutes } = splitWindowMinutes(traffic.windowMinutes);
    if (hours === 0) return t('dashboard.window_m', { minutes });
    if (minutes === 0) return t('dashboard.window_h', { hours });
    return t('dashboard.window_hm', { hours, minutes });
  }, [traffic.windowMinutes, t]);

  const routingStrategy = useMemo(() => {
    const raw = config?.routingStrategy?.trim() ?? '';
    if (!raw) return DASH;
    if (raw === 'round-robin') return t('basic_settings.routing_strategy_round_robin');
    if (raw === 'weighted-round-robin') {
      return t('basic_settings.routing_strategy_weighted_round_robin');
    }
    if (raw === 'fill-first') return t('basic_settings.routing_strategy_fill_first');
    return raw;
  }, [config?.routingStrategy, t]);

  const unknownProviderLabel = t('dashboard.provider_unknown');
  const successRateTone = toneForSuccessRate(traffic.successRate);

  /** 标题是算出来的判词，不是写死的口号；句尾句号充当状态灯 */
  const verdict = useMemo(() => {
    if (!connected) {
      return connectionStatus === 'connecting'
        ? { key: 'hero_verdict_connecting', accent: 'var(--amber-color)' }
        : { key: 'hero_verdict_offline', accent: 'var(--text-quaternary)' };
    }
    if (traffic.total === 0 || traffic.successRate === null) {
      return { key: 'hero_verdict_idle', accent: 'var(--text-quaternary)' };
    }
    const keyByTone: Record<MeterTone, string> = {
      good: 'hero_verdict_good',
      warning: 'hero_verdict_warning',
      critical: 'hero_verdict_critical',
      idle: 'hero_verdict_idle',
    };
    return { key: keyByTone[successRateTone], accent: TILE_ACCENTS[successRateTone] };
  }, [connected, connectionStatus, traffic.total, traffic.successRate, successRateTone]);

  const connectionLabel = t(
    connectionStatus === 'connected'
      ? 'common.connected'
      : connectionStatus === 'connecting'
        ? 'common.connecting'
        : 'common.disconnected'
  );
  const versionLabel = serverVersion ? `v${serverVersion.trim().replace(/^[vV]+/, '')}` : null;
  const heroMetaLine = [versionLabel, connectionLabel].filter(Boolean).join(' · ');

  const statTiles = [
    {
      key: 'success',
      label: t('dashboard.success_rate'),
      value: traffic.successRate === null ? DASH : formatPercent(traffic.successRate),
      hint: t('dashboard.stat_success_hint', { total: traffic.total.toLocaleString() }),
      meter: traffic.successRate,
      tone: successRateTone,
    },
    {
      key: 'credentials',
      label: t('dashboard.stat_credentials'),
      value: credentials ? credentials.total.toLocaleString() : DASH,
      hint: credentials
        ? t('dashboard.stat_credentials_hint', {
            active: credentials.active,
            disabled: credentials.disabled + credentials.unavailable,
          })
        : t('dashboard.stat_credentials_empty'),
      meter:
        credentials && credentials.total > 0
          ? (credentials.active / credentials.total) * 100
          : null,
      tone: undefined,
    },
    {
      key: 'providerKeys',
      label: t('dashboard.stat_provider_keys'),
      value: counts.providerKeys === null ? DASH : counts.providerKeys.toLocaleString(),
      hint: t('dashboard.stat_provider_keys_hint'),
      meter: null,
      tone: undefined,
    },
    {
      key: 'models',
      label: t('dashboard.stat_models'),
      value: counts.models === null ? DASH : counts.models.toLocaleString(),
      hint: t('dashboard.stat_models_hint'),
      meter: null,
      tone: undefined,
    },
  ];

  const runtimeRows: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: t('dashboard.runtime_routing'), value: routingStrategy },
    { label: t('dashboard.runtime_retry'), value: String(config?.requestRetry ?? 0) },
    {
      label: t('dashboard.runtime_management_keys'),
      value: counts.managementKeys === null ? DASH : String(counts.managementKeys),
    },
    { label: t('dashboard.runtime_version'), value: serverVersion?.trim() || DASH },
    {
      label: t('dashboard.runtime_build'),
      value: formatDateValue(serverBuildDate, i18n.language) || DASH,
    },
    { label: t('dashboard.runtime_proxy'), value: config?.proxyUrl?.trim() || DASH, mono: true },
  ];

  const runtimeToggles = config
    ? [
        { label: t('dashboard.runtime_debug'), on: Boolean(config.debug) },
        { label: t('dashboard.runtime_file_logging'), on: Boolean(config.loggingToFile) },
        { label: t('dashboard.runtime_request_log'), on: Boolean(config.requestLog) },
        { label: t('dashboard.runtime_ws_auth'), on: Boolean(config.wsAuth) },
        { label: t('dashboard.runtime_model_prefix'), on: Boolean(config.forceModelPrefix) },
      ]
    : [];

  const ctaCards = [
    {
      to: '/ai-providers',
      icon: <IconBot size={20} />,
      title: t('nav.ai_providers'),
      description: t('dashboard.cta_providers_desc'),
    },
    {
      to: '/auth-files',
      icon: <IconFileText size={20} />,
      title: t('nav.auth_files'),
      description: t('dashboard.cta_auth_files_desc'),
    },
    {
      to: '/config',
      icon: <IconSidebarConfig size={20} />,
      title: t('nav.config_management'),
      description: t('dashboard.cta_config_desc'),
    },
    {
      to: '/quota',
      icon: <IconSidebarQuota size={20} />,
      title: t('nav.quota_management'),
      description: t('dashboard.cta_quota_desc'),
    },
    {
      to: '/logs',
      icon: <IconSidebarLogs size={20} />,
      title: t('nav.logs'),
      description: t('dashboard.cta_logs_desc'),
    },
    {
      to: '/system',
      icon: <IconSidebarSystem size={20} />,
      title: t('nav.system_info'),
      description: t('dashboard.cta_system_desc'),
    },
  ];

  return (
    <div className={styles.page}>
      {/* ---------- Title row ---------- */}
      <header className={styles.titleRow} ref={heroRef}>
        <div className={styles.titleBlock} data-reveal>
          <h1 className={styles.pageTitle}>{t('nav.dashboard')}</h1>
          <span className={styles.pageSubtitle}>
            <i
              className={styles.statusDot}
              style={{ background: verdict.accent }}
              aria-hidden="true"
            />
            {t(`dashboard.${verdict.key}`)}
            {heroMetaLine ? <span className={styles.subtitleMeta}> · {heroMetaLine}</span> : null}
          </span>
        </div>
        <div className={styles.titleActions} data-reveal>
          <Link to="/logs" className={styles.ghostAction}>
            {t('dashboard.cta_inspect_logs')}
          </Link>
          <Link to="/ai-providers" className={styles.primaryAction}>
            {t('dashboard.cta_manage_providers')}
          </Link>
        </div>
      </header>

      {/* ---------- Requests: headline number, KPIs and throughput in one card ---------- */}
      <section className={styles.card} ref={trafficRef}>
        <header className={styles.cardHead}>
          <h2 className={styles.cardTitle}>
            {t('dashboard.hero_requests_label')}
            <span className={styles.cardSubtitle}>
              {t('dashboard.hero_window_meta', { window: windowLabel })}
            </span>
          </h2>
          {connected && (
            <span className={styles.liveBadge}>
              <i className={styles.liveDot} aria-hidden="true" />
              {t('dashboard.hero_live')}
            </span>
          )}
        </header>
        <div className={styles.heroRow}>
          <strong className={styles.heroFigure}>
            {connected ? formatHeadline(animatedTotal) : DASH}
            <small>{t('dashboard.fleet_requests')}</small>
          </strong>
          <dl className={styles.stats} ref={statsRef} aria-label={t('dashboard.stats_aria')}>
            {statTiles.map((tile) => (
              <div key={tile.key} className={styles.stat} data-reveal>
                <dt className={styles.statLabel}>{tile.label}</dt>
                <dd
                  className={styles.statValue}
                  style={
                    tile.tone && tile.tone !== 'good' && tile.tone !== 'idle'
                      ? { color: TILE_ACCENTS[tile.tone] }
                      : undefined
                  }
                >
                  {tile.value}
                </dd>
                {tile.key === 'credentials' && <dd className={styles.statHint}>{tile.hint}</dd>}
              </div>
            ))}
          </dl>
        </div>
        <ThroughputChart traffic={traffic} />
      </section>

      {/* ---------- Provider fleet ---------- */}
      <section className={styles.card} ref={fleetRef}>
        <header className={styles.cardHead}>
          <h2 className={styles.cardTitle}>
            {t('dashboard.fleet_title')}
            <span className={styles.cardSubtitle}>{t('dashboard.fleet_description')}</span>
          </h2>
        </header>
        {providers.length === 0 ? (
          <p className={styles.emptyNote}>{t('dashboard.fleet_empty')}</p>
        ) : (
          <ul className={styles.fleetList}>
            {providers.map((provider) => (
              <li key={provider.id} className={styles.fleetRow}>
                <div className={styles.fleetIdentity}>
                  <span className={styles.fleetName}>
                    {providerLabel(provider.id, unknownProviderLabel)}
                  </span>
                  <span className={styles.fleetMeta}>
                    {t('dashboard.fleet_credentials', { value: provider.credentials })}
                  </span>
                </div>
                <Sparkline
                  points={provider.buckets.map((bucket) => bucket.success + bucket.failed)}
                  color={FLEET_ACCENTS[provider.id] ?? 'var(--text-secondary)'}
                  ariaLabel={t('dashboard.fleet_spark_label', {
                    provider: providerLabel(provider.id, unknownProviderLabel),
                  })}
                  className={styles.fleetSpark}
                />
                <div className={styles.fleetNumbers}>
                  <span className={styles.fleetTotal}>{provider.total.toLocaleString()}</span>
                  <span className={styles.fleetTotalLabel}>{t('dashboard.fleet_requests')}</span>
                </div>
                <div className={styles.fleetRate}>
                  <span className={styles.fleetRateValue}>
                    {provider.successRate === null ? DASH : formatPercent(provider.successRate)}
                  </span>
                  <Meter
                    value={provider.successRate}
                    ariaLabel={t('dashboard.success_rate')}
                    className={styles.fleetMeter}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------- Credential health + runtime ---------- */}
      <section className={styles.detailGrid} ref={detailRef}>
        <div className={styles.card} data-reveal>
          <header className={styles.cardHead}>
            <h2 className={styles.cardTitle}>{t('dashboard.health_title')}</h2>
          </header>
          {!credentials || credentials.total === 0 ? (
            <p className={styles.emptyNote}>{t('dashboard.health_empty')}</p>
          ) : (
            <>
              <div className={styles.healthBar}>
                {credentials.active > 0 && (
                  <span
                    className={`${styles.healthSegment} ${styles.healthActive}`}
                    style={{ flexGrow: credentials.active }}
                  />
                )}
                {credentials.unavailable > 0 && (
                  <span
                    className={`${styles.healthSegment} ${styles.healthUnavailable}`}
                    style={{ flexGrow: credentials.unavailable }}
                  />
                )}
                {credentials.disabled > 0 && (
                  <span
                    className={`${styles.healthSegment} ${styles.healthDisabled}`}
                    style={{ flexGrow: credentials.disabled }}
                  />
                )}
              </div>
              <ul className={styles.healthLegend}>
                <li>
                  <i className={`${styles.healthKey} ${styles.healthActive}`} aria-hidden="true" />
                  {t('dashboard.health_active')}
                  <b>{credentials.active.toLocaleString()}</b>
                </li>
                <li>
                  <i
                    className={`${styles.healthKey} ${styles.healthUnavailable}`}
                    aria-hidden="true"
                  />
                  {t('dashboard.health_unavailable')}
                  <b>{credentials.unavailable.toLocaleString()}</b>
                </li>
                <li>
                  <i
                    className={`${styles.healthKey} ${styles.healthDisabled}`}
                    aria-hidden="true"
                  />
                  {t('dashboard.health_disabled')}
                  <b>{credentials.disabled.toLocaleString()}</b>
                </li>
              </ul>
              <dl className={styles.specList}>
                {credentials.byType.map((entry) => (
                  <div key={entry.type} className={styles.specRow}>
                    <dt className={styles.specLabel}>
                      {providerLabel(entry.type, unknownProviderLabel)}
                    </dt>
                    <dd className={styles.specValue}>{entry.count.toLocaleString()}</dd>
                  </div>
                ))}
              </dl>
              <Link to="/auth-files" className={styles.panelLink}>
                {t('dashboard.health_link')}
              </Link>
            </>
          )}
        </div>

        <div className={styles.card} data-reveal>
          <header className={styles.cardHead}>
            <h2 className={styles.cardTitle}>{t('dashboard.runtime_title')}</h2>
          </header>
          <dl className={styles.specList}>
            {runtimeRows.map((row) => (
              <div key={row.label} className={styles.specRow}>
                <dt className={styles.specLabel}>{row.label}</dt>
                <dd className={`${styles.specValue} ${row.mono ? styles.specMono : ''}`}>
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
          {runtimeToggles.length > 0 && (
            <ul className={styles.toggleList}>
              {runtimeToggles.map((toggle) => (
                <li
                  key={toggle.label}
                  className={`${styles.togglePill} ${toggle.on ? styles.toggleOn : styles.toggleOff}`}
                >
                  {toggle.label}
                  <b>{toggle.on ? t('common.yes') : t('common.no')}</b>
                </li>
              ))}
            </ul>
          )}
          <Link to="/config" className={styles.panelLink}>
            {t('dashboard.runtime_link')}
          </Link>
        </div>
      </section>

      {/* ---------- Shortcuts ---------- */}
      <section className={styles.section} ref={ctaRef}>
        <h2 className={styles.sectionTitle} data-reveal>
          {t('dashboard.cta_title')}
        </h2>
        <div className={styles.ctaGrid}>
          {ctaCards.map((card) => (
            <Link key={card.to} to={card.to} className={styles.ctaCard} data-reveal>
              <span className={styles.ctaIcon}>{card.icon}</span>
              <span className={styles.ctaText}>
                <span className={styles.ctaTitle}>{card.title}</span>
                <span className={styles.ctaDescription}>{card.description}</span>
              </span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
