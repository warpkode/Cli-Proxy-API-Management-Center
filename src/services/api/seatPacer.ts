/**
 * claude-seat-pacer plugin status.
 *
 * The plugin polls Anthropic's usage endpoint on its own schedule (every two
 * minutes by default) and exposes the cached snapshots on a plugin-declared
 * route. Reading it costs no upstream request. The route keeps its declared v0
 * path (plugin routes are the sanctioned exception to v8-only) and is optional:
 * a backend without the plugin answers 404, which resolves to `null`.
 */

import type { ApiError } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { isRecord } from '@/utils/helpers';
import { parseTimestampMs } from '@/utils/timestamp';
import { apiClient } from './client';

export const SEAT_PACER_PLUGIN_ID = 'claude-seat-pacer';
export const SEAT_PACER_STATUS_PATH = `/v0/management/plugins/${SEAT_PACER_PLUGIN_ID}/status`;

export interface SeatPacerWindow {
  /** `five_hour` | `seven_day` | `weekly_scoped` | future kinds. */
  kind: string;
  /** 0..1 */
  utilization: number;
  resetsAtMs: number | null;
  active: boolean;
  /** `normal` | `warning` | `critical` */
  severity: string;
  status?: string;
  scope?: string;
}

export interface SeatPacerAccount {
  authId: string;
  email?: string;
  /** Joins to the credential's auth_index. */
  authIndex?: string;
  observedAtMs: number | null;
  source?: string;
  windows: SeatPacerWindow[];
}

export interface SeatPacerStatus {
  polledAtMs: number | null;
  nextPollAtMs: number | null;
  serverNowMs: number | null;
  pollIntervalSeconds: number | null;
  accounts: SeatPacerAccount[];
}

const readString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const readInstantMs = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Epoch seconds and milliseconds both appear in plugin payloads.
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = parseTimestampMs(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const readFiniteNumber = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Number(value.trim()) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
};

/** Seconds from a number or a Go-style duration (`2m`, `1m30s`, `90s`). */
const readDurationSeconds = (value: unknown): number | null => {
  const numeric = readFiniteNumber(value);
  if (numeric !== null) return numeric;
  if (typeof value !== 'string') return null;
  const pattern = /(\d+(?:\.\d+)?)(h|m|s)/g;
  let total = 0;
  let matched = false;
  for (const [, amount, unit] of value.trim().matchAll(pattern)) {
    matched = true;
    total += Number(amount) * (unit === 'h' ? 3600 : unit === 'm' ? 60 : 1);
  }
  return matched ? total : null;
};

const normalizeWindow = (value: unknown): SeatPacerWindow | null => {
  if (!isRecord(value)) return null;
  const kind = readString(value.kind);
  const utilization = readFiniteNumber(value.utilization);
  if (!kind || utilization === null) return null;
  const status = readString(value.status);
  const scope = readString(value.scope);
  return {
    kind,
    utilization: Math.max(0, utilization),
    resetsAtMs: readInstantMs(value.resets_at ?? value.resetsAt),
    active: value.active === true,
    severity: readString(value.severity) ?? 'normal',
    ...(status ? { status } : {}),
    ...(scope ? { scope } : {}),
  };
};

const normalizeAccount = (value: unknown): SeatPacerAccount | null => {
  if (!isRecord(value)) return null;
  const snapshot = isRecord(value.snapshot) ? value.snapshot : {};
  const authId = readString(value.auth_id ?? value.authId) ?? '';
  const authIndex =
    normalizeAuthIndex(snapshot.auth_index ?? value.auth_index ?? snapshot.authIndex) ?? undefined;
  if (!authId && !authIndex) return null;
  const windows = Array.isArray(snapshot.windows)
    ? snapshot.windows.map(normalizeWindow).filter((item): item is SeatPacerWindow => item !== null)
    : [];
  const email = readString(value.email);
  const source = readString(snapshot.source);
  return {
    authId,
    ...(email ? { email } : {}),
    ...(authIndex ? { authIndex } : {}),
    observedAtMs: readInstantMs(snapshot.observed_at ?? snapshot.observedAt),
    ...(source ? { source } : {}),
    windows,
  };
};

export function normalizeSeatPacerStatus(payload: unknown): SeatPacerStatus | null {
  if (!isRecord(payload)) return null;
  const config = isRecord(payload.config) ? payload.config : {};
  const quotaConfig = isRecord(config.quota) ? config.quota : {};
  const accounts = Array.isArray(payload.auths)
    ? payload.auths.map(normalizeAccount).filter((item): item is SeatPacerAccount => item !== null)
    : [];
  return {
    polledAtMs: readInstantMs(payload.polled_at),
    nextPollAtMs: readInstantMs(payload.next_poll_at),
    serverNowMs: readInstantMs(payload.now),
    pollIntervalSeconds: readDurationSeconds(quotaConfig.poll_interval),
    accounts,
  };
}

export const seatPacerApi = {
  /** Cached plugin snapshots; `null` when the plugin is not installed (404). */
  async status(): Promise<SeatPacerStatus | null> {
    try {
      const payload = await apiClient.get<unknown>(
        apiClient.resolveServerUrl(SEAT_PACER_STATUS_PATH)
      );
      return normalizeSeatPacerStatus(payload);
    } catch (error: unknown) {
      if ((error as ApiError | undefined)?.status === 404) return null;
      throw error;
    }
  },
};
