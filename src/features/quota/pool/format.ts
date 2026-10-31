/**
 * Locale-aware formatting for the pool view. Pure; formatters are cached per
 * locale because the chart formats hundreds of ticks and tooltip readouts.
 */

import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';

const formatters = new Map<string, Intl.DateTimeFormat>();

const getFormatter = (locale: string | undefined, options: Intl.DateTimeFormatOptions) => {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`;
  const cached = formatters.get(key);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat(locale, options);
  } catch {
    formatter = new Intl.DateTimeFormat(undefined, options);
  }
  formatters.set(key, formatter);
  return formatter;
};

/**
 * Axis label, e.g. `Fri 23`. ICU orders English as `23 Fri`; weekday-first reads
 * as a calendar. Other locales keep their native order (`23日周五`).
 */
export const formatAxisDay = (ms: number, locale?: string) => {
  const formatter = getFormatter(locale, { weekday: 'short', day: 'numeric' });
  if (!formatter.resolvedOptions().locale.startsWith('en')) return formatter.format(ms);
  const parts = formatter.formatToParts(ms);
  const weekday = parts.find((part) => part.type === 'weekday')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return weekday && day ? `${weekday} ${day}` : formatter.format(ms);
};

/** Range label part, e.g. `Oct 23`. */
export const formatShortDate = (ms: number, locale?: string) =>
  getFormatter(locale, { month: 'short', day: 'numeric' }).format(ms);

/** e.g. `Tue 10:00 AM` */
export const formatWeekdayTime = (ms: number, locale?: string) =>
  getFormatter(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(ms);

/** e.g. `Oct 23, 10:00 AM` */
export const formatDateTime = (ms: number, locale?: string) =>
  getFormatter(locale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(ms);

/** A weekday is unambiguous within six days of now; beyond that, show the date. */
export const formatInstant = (ms: number, nowMs: number, locale?: string) =>
  Math.abs(ms - nowMs) < 6 * DAY_MS ? formatWeekdayTime(ms, locale) : formatDateTime(ms, locale);

export interface DurationParts {
  days: number;
  hours: number;
  minutes: number;
}

/** Truncated parts of a non-negative duration. */
export function durationParts(ms: number): DurationParts {
  const safe = Math.max(0, ms);
  return {
    days: Math.floor(safe / DAY_MS),
    hours: Math.floor((safe % DAY_MS) / HOUR_MS),
    minutes: Math.floor((safe % HOUR_MS) / MINUTE_MS),
  };
}

export const formatPercent = (value: number) => `${Math.round(value)}%`;

/** One decimal under 10, whole numbers above: `0.4%/h`, `3.7%/h`, `12%/h`. */
export const formatRate = (value: number) =>
  `${value < 10 ? (Math.round(value * 10) / 10).toFixed(1) : Math.round(value)}%/h`;
