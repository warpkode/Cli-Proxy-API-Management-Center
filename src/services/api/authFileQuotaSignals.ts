import type { AuthFileQuotaSignals } from '@/types/authFile';
import { isRecord } from '@/utils/helpers';
import { normalizeCooldownTimestamp } from './authFileCooldowns';

/** Header values are strings on the wire; tolerate scalars from older/other encoders. */
const readSignalValue = (value: unknown): string | null => {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
};

/**
 * Normalize the hub's cached `quota: { observed_at, signals }` block.
 *
 * Returns undefined when the server sends nothing usable, so callers can tell
 * "no cached headers" apart from "headers with no values". Header names are kept
 * verbatim; the quota feature matches them case-insensitively.
 */
export function normalizeAuthFileQuotaSignals(value: unknown): AuthFileQuotaSignals | undefined {
  if (!isRecord(value)) return undefined;
  const rawSignals = isRecord(value.signals) ? value.signals : null;
  if (!rawSignals) return undefined;

  const signals: Record<string, string> = {};
  for (const [key, raw] of Object.entries(rawSignals)) {
    const name = key.trim();
    const signal = readSignalValue(raw);
    if (!name || signal === null || signal === '') continue;
    signals[name] = signal;
  }
  if (Object.keys(signals).length === 0) return undefined;

  const observedAt = normalizeCooldownTimestamp(value.observed_at ?? value.observedAt);
  return observedAt ? { observedAt, signals } : { signals };
}
