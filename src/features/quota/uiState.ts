import {
  QUOTA_SORT_MODES,
  QUOTA_TAB_ORDER,
  type QuotaSortMode,
  type QuotaTabId,
} from './constants';
import {
  BURN_WINDOWS_HOURS,
  FUTURE_USAGE_FACTORS,
  type BurnWindowHours,
  type FutureUsageMode,
} from './pool/poolModel';

export const POOL_METRICS = ['remaining', 'drain'] as const;
export type PoolMetric = (typeof POOL_METRICS)[number];

/** 额度页 UI 偏好：会话级持久化（sessionStorage），跨会话不携带。 */
export type QuotaUiState = {
  tab?: QuotaTabId;
  sortMode?: QuotaSortMode;
  metric?: PoolMetric;
  burnWindow?: BurnWindowHours;
  futureUsage?: FutureUsageMode;
  showAccounts?: boolean;
  checksOpen?: boolean;
};

const QUOTA_UI_STATE_KEY = 'quotaPage.uiState';
/** Email visibility outlives the session: hiding addresses is a standing choice. */
const SHOW_EMAILS_KEY = 'quotaPage.showEmails';

const QUOTA_TAB_ID_SET = new Set<string>(['all', ...QUOTA_TAB_ORDER]);
const QUOTA_SORT_MODE_SET = new Set<string>(QUOTA_SORT_MODES);

export const isQuotaTabId = (value: unknown): value is QuotaTabId =>
  typeof value === 'string' && QUOTA_TAB_ID_SET.has(value);

export const isQuotaSortMode = (value: unknown): value is QuotaSortMode =>
  typeof value === 'string' && QUOTA_SORT_MODE_SET.has(value);

export const isPoolMetric = (value: unknown): value is PoolMetric =>
  typeof value === 'string' && (POOL_METRICS as readonly string[]).includes(value);

export const isBurnWindow = (value: unknown): value is BurnWindowHours =>
  typeof value === 'number' && (BURN_WINDOWS_HOURS as readonly number[]).includes(value);

export const isFutureUsageMode = (value: unknown): value is FutureUsageMode =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(FUTURE_USAGE_FACTORS, value);

const readBoolean = (value: unknown) => (typeof value === 'boolean' ? value : undefined);

export const readQuotaUiState = (): QuotaUiState | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(QUOTA_UI_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as QuotaUiState;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      tab: isQuotaTabId(parsed.tab) ? parsed.tab : undefined,
      sortMode: isQuotaSortMode(parsed.sortMode) ? parsed.sortMode : undefined,
      metric: isPoolMetric(parsed.metric) ? parsed.metric : undefined,
      burnWindow: isBurnWindow(parsed.burnWindow) ? parsed.burnWindow : undefined,
      futureUsage: isFutureUsageMode(parsed.futureUsage) ? parsed.futureUsage : undefined,
      showAccounts: readBoolean(parsed.showAccounts),
      checksOpen: readBoolean(parsed.checksOpen),
    };
  } catch {
    return null;
  }
};

/**
 * Merge into whatever is already stored.
 *
 * Callers write one preference at a time — the tab strip knows nothing about
 * the sort control — so a whole-object write would silently drop the other
 * field every time either one changed.
 */
export const writeQuotaUiState = (state: QuotaUiState) => {
  if (typeof window === 'undefined') return;
  try {
    const next = { ...readQuotaUiState(), ...state };
    window.sessionStorage.setItem(QUOTA_UI_STATE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
};

/** Emails are hidden unless the user chose to show them. */
export const readShowEmails = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SHOW_EMAILS_KEY) === 'true';
  } catch {
    return false;
  }
};

export const writeShowEmails = (value: boolean) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SHOW_EMAILS_KEY, value ? 'true' : 'false');
  } catch {
    // ignore
  }
};
