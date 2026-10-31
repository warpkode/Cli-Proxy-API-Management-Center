/**
 * Pool time-series chart: solid recorded history up to "Now", dashed projection
 * after it, "+X%" step-up annotations naming the account that refills, amber
 * markers for reset grants (spent "⟲ +X%" steps and dotted expiry lines).
 *
 * Layout only; the series come from pool/poolView.ts. Hover and keyboard share
 * one cursor that snaps to drawn points (arrow keys step, Shift+arrow jumps
 * about a day, Home/End go to the ends, Escape clears). The readout sits in a
 * pill at the top right of the plot.
 */

import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { areaPath, createScale, linePath, placeStepLabels } from '../pool/chartGeometry';
import { formatAxisDay, formatInstant, formatPercent } from '../pool/format';
import { dayTicks, type TimeRange } from '../pool/poolModel';
import type { SeriesPoint, StepUpEvent } from '../pool/types';
import styles from './PoolChart.module.scss';

export interface PoolChartMarker {
  t: number;
  key: string;
}

export interface PoolChartProps {
  range: TimeRange;
  nowMs: number;
  yMax: number;
  /** Series color (provider hue, may be a CSS variable). Text never takes it. */
  color: string;
  recorded: SeriesPoint[];
  projected: SeriesPoint[];
  recordedStepUps?: readonly StepUpEvent[];
  projectedStepUps?: readonly StepUpEvent[];
  /** Short account names under each step label; omit for single-account pools. */
  stepNames?: (accountIds: readonly string[]) => string;
  /** Expiry instants of reset grants the projection leaves unspent. */
  expiryMarkers?: readonly PoolChartMarker[];
  emptyAtMs?: number | null;
  /** Gaps in recorded data longer than this lift the pen. */
  maxGapMs: number;
  /** Legend title: what the line measures. */
  seriesLabel: string;
  formatTick: (value: number) => string;
  /** Readout value, e.g. `398% left` or `3.7%/h`. */
  formatReadout: (value: number) => string;
  ariaLabel: string;
  /** Width used before the first measurement (and in static renders). */
  initialWidth?: number;
  height?: number;
}

const DEFAULT_HEIGHT = 300;
const MARGINS = { top: 44, right: 6, bottom: 30, left: 50 };
const DAY_LABEL_MIN_PX = 46;
const LABEL_LINE_PX = 13;

interface NavPoint extends SeriesPoint {
  kind: 'recorded' | 'projected';
}

/** Index of the point nearest `t` in a time-sorted array. */
const nearestIndex = (points: readonly NavPoint[], t: number): number => {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo <= 0) return 0;
  if (lo >= points.length) return points.length - 1;
  return t - points[lo - 1].t <= points[lo].t - t ? lo - 1 : lo;
};

export function PoolChart(props: PoolChartProps) {
  const {
    range,
    nowMs,
    yMax,
    color,
    recorded,
    projected,
    recordedStepUps = [],
    projectedStepUps = [],
    stepNames,
    expiryMarkers = [],
    emptyAtMs = null,
    maxGapMs,
    seriesLabel,
    formatTick,
    formatReadout,
    ariaLabel,
    initialWidth = 960,
    height = DEFAULT_HEIGHT,
  } = props;
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const clipId = `pool-clip-${uid}`;
  const fillId = `pool-fill-${uid}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initialWidth);
  const [cursor, setCursor] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      const next = Math.round(element.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale = useMemo(
    () => createScale(range, yMax, width, height, MARGINS),
    [range, yMax, width, height]
  );
  const { plot } = scale;
  const plotBottom = plot.top + plot.height;

  const navPoints = useMemo<NavPoint[]>(() => {
    const past = recorded.map((point) => ({ ...point, kind: 'recorded' as const }));
    const lastRecorded = past.length > 0 ? past[past.length - 1].t : Number.NEGATIVE_INFINITY;
    const future = projected
      .filter((point) => point.t > lastRecorded)
      .map((point) => ({ ...point, kind: 'projected' as const }));
    return [...past, ...future].filter(
      (point) => point.t >= range.startMs && point.t <= range.endMs
    );
  }, [recorded, projected, range]);

  // Path strings depend only on data and size, not on the hover cursor.
  const paths = useMemo(
    () => ({
      area: areaPath(navPoints, scale, maxGapMs),
      recordedLine: linePath(recorded, scale, maxGapMs),
      projectedLine: linePath(projected, scale, maxGapMs),
    }),
    [navPoints, recorded, projected, scale, maxGapMs]
  );

  const days = useMemo(() => dayTicks(range), [range]);
  const pxPerDay = scale.x(range.startMs + 86_400_000) - scale.x(range.startMs) || 1;
  const labelEvery = Math.max(1, Math.ceil(DAY_LABEL_MIN_PX / pxPerDay));

  const nowInRange = nowMs >= range.startMs && nowMs <= range.endMs;
  const liveValue =
    recorded.length > 0 && recorded[recorded.length - 1].t === nowMs
      ? recorded[recorded.length - 1].value
      : (projected.find((point) => point.t >= nowMs)?.value ?? null);

  const stepLabels = useMemo(() => {
    const format = (amount: number) => `+${formatPercent(amount)}`;
    const minGapPx = stepNames ? 62 : 38;
    return [
      ...placeStepLabels(recordedStepUps, recorded, scale, {
        minAmount: 5,
        minGapPx,
        format,
        maxLevel: 1,
      }),
      ...placeStepLabels(projectedStepUps, projected, scale, {
        minAmount: 1,
        minGapPx,
        format,
        maxLevel: 2,
      }),
    ];
  }, [recordedStepUps, projectedStepUps, recorded, projected, scale, stepNames]);

  const yTicks = [0, yMax / 2, yMax];
  const hover =
    cursor !== null && navPoints.length > 0
      ? navPoints[Math.min(cursor, navPoints.length - 1)]
      : null;
  const hoverX = hover ? scale.x(hover.t) : 0;

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (navPoints.length === 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - bounds.left;
    if (px < plot.left - 8 || px > plot.left + plot.width + 8) {
      setCursor(null);
      return;
    }
    setCursor(nearestIndex(navPoints, scale.invertX(px)));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (navPoints.length === 0) return;
    const last = navPoints.length - 1;
    const current = cursor ?? nearestIndex(navPoints, nowMs);
    const jump = Math.max(1, Math.round(navPoints.length / 14));
    let next: number | null;
    switch (event.key) {
      case 'ArrowRight':
        next = Math.min(last, current + (event.shiftKey ? jump : 1));
        break;
      case 'ArrowLeft':
        next = Math.max(0, current - (event.shiftKey ? jump : 1));
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      case 'Escape':
        next = null;
        break;
      default:
        return;
    }
    event.preventDefault();
    setCursor(next);
  };

  const readoutKind = (kind: NavPoint['kind']) =>
    kind === 'recorded'
      ? t('quota_management.pool_tooltip_recorded')
      : t('quota_management.pool_tooltip_projected');

  const emptyX = emptyAtMs !== null ? scale.x(emptyAtMs) : null;
  const emptyVisible = emptyAtMs !== null && emptyAtMs >= range.startMs && emptyAtMs <= range.endMs;

  return (
    <div className={styles.chart}>
      <div
        ref={containerRef}
        className={styles.plotWrap}
        tabIndex={0}
        role="group"
        aria-label={ariaLabel}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setCursor(null)}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (cursor === null && navPoints.length > 0) setCursor(nearestIndex(navPoints, nowMs));
        }}
        onBlur={() => setCursor(null)}
      >
        <svg
          className={styles.svg}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={plot.left} y={plot.top - 2} width={plot.width} height={plot.height + 4} />
            </clipPath>
            <linearGradient id={fillId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" style={{ stopColor: color }} className={styles.fillTop} />
              <stop offset="1" style={{ stopColor: color }} className={styles.fillBottom} />
            </linearGradient>
          </defs>

          {days.map((day, index) => {
            const x = scale.x(day);
            const labelX = scale.x(day + 43_200_000);
            const showLabel =
              index % labelEvery === 0 && labelX > plot.left && labelX < plot.left + plot.width;
            return (
              <g key={day}>
                <line className={styles.dayLine} x1={x} x2={x} y1={plot.top} y2={plotBottom} />
                {showLabel && (
                  <text className={styles.axisLabel} x={labelX} y={plotBottom + 19}>
                    {formatAxisDay(day, locale)}
                  </text>
                )}
              </g>
            );
          })}

          {yTicks.map((value) => (
            <g key={value}>
              <line
                className={styles.gridLine}
                x1={plot.left}
                x2={plot.left + plot.width}
                y1={scale.y(value)}
                y2={scale.y(value)}
              />
              <text
                className={styles.tickLabel}
                x={plot.left - 12}
                y={scale.y(value)}
                dominantBaseline="middle"
              >
                {formatTick(value)}
              </text>
            </g>
          ))}

          {expiryMarkers.map((marker) => {
            const x = scale.x(marker.t);
            return (
              <line
                key={marker.key}
                className={styles.expiryLine}
                x1={x}
                x2={x}
                y1={plot.top}
                y2={plotBottom}
                strokeDasharray="2 4"
              />
            );
          })}

          <g clipPath={`url(#${clipId})`}>
            <path className={styles.area} d={paths.area} fill={`url(#${fillId})`} />
            <path className={styles.recorded} d={paths.recordedLine} style={{ stroke: color }} />
            <path
              className={styles.projected}
              d={paths.projectedLine}
              style={{ stroke: color }}
              strokeDasharray="6 6"
            />
          </g>

          {nowInRange && (
            <g>
              <line
                className={styles.nowLine}
                x1={scale.x(nowMs)}
                x2={scale.x(nowMs)}
                y1={plot.top - 14}
                y2={plotBottom}
              />
              <text className={styles.nowLabel} x={scale.x(nowMs)} y={plot.top - 20}>
                {t('quota_management.pool_now')}
              </text>
            </g>
          )}

          {stepLabels.map((label) => {
            const grant = label.event.kind === 'grant';
            const name = stepNames ? stepNames(label.event.accountIds) : '';
            const lines = name ? 2 : 1;
            const base = Math.max(
              12 + (lines - 1) * LABEL_LINE_PX,
              label.y - label.level * (lines * LABEL_LINE_PX + 4)
            );
            return (
              <g key={label.key} className={grant ? styles.grantStep : undefined}>
                <text
                  className={styles.stepLabel}
                  x={label.x}
                  y={base - (lines - 1) * LABEL_LINE_PX}
                >
                  {grant ? `⟲ ${label.text}` : label.text}
                </text>
                {name && (
                  <text className={styles.stepName} x={label.x} y={base}>
                    {name}
                  </text>
                )}
              </g>
            );
          })}

          {nowInRange && liveValue !== null && (
            <circle
              className={styles.dot}
              cx={scale.x(nowMs)}
              cy={scale.y(liveValue)}
              r={4.5}
              style={{ fill: color }}
            />
          )}

          {emptyVisible && emptyX !== null && (
            <g>
              <circle
                className={styles.emptyMarker}
                cx={emptyX}
                cy={scale.y(0)}
                r={5}
                style={{ stroke: color }}
              />
              <text
                className={styles.emptyLabel}
                x={Math.min(plot.left + plot.width - 70, Math.max(plot.left + 70, emptyX))}
                y={scale.y(0) - 12}
              >
                {t('quota_management.pool_empty_marker', {
                  time: formatInstant(emptyAtMs as number, nowMs, locale),
                })}
              </text>
            </g>
          )}

          {hover && (
            <g>
              <line
                className={styles.crosshair}
                x1={hoverX}
                x2={hoverX}
                y1={plot.top}
                y2={plotBottom}
                style={{ stroke: color }}
              />
              <circle
                className={styles.dot}
                cx={hoverX}
                cy={scale.y(hover.value)}
                r={4.5}
                style={{ fill: color }}
              />
            </g>
          )}
        </svg>

        <div role="status" className={hover ? styles.readout : styles.srOnly}>
          {hover && (
            <>
              {formatInstant(hover.t, nowMs, locale)} · {formatReadout(hover.value)} ·{' '}
              {readoutKind(hover.kind)}
            </>
          )}
        </div>
      </div>

      <div className={styles.legend}>
        <span className={styles.legendTitle}>{seriesLabel}</span>
        <span className={styles.legendItem}>
          <svg width="20" height="8" aria-hidden="true" focusable="false">
            <line x1="1" x2="19" y1="4" y2="4" style={{ stroke: color }} className={styles.key} />
          </svg>
          {t('quota_management.pool_legend_recorded')}
        </span>
        <span className={styles.legendItem}>
          <svg width="20" height="8" aria-hidden="true" focusable="false">
            <line
              x1="1"
              x2="19"
              y1="4"
              y2="4"
              style={{ stroke: color }}
              strokeDasharray="4 3"
              className={styles.key}
            />
          </svg>
          {t('quota_management.pool_legend_projected')}
        </span>
        {expiryMarkers.length > 0 && (
          <span className={styles.legendItem}>
            <svg width="20" height="8" aria-hidden="true" focusable="false">
              <line
                x1="1"
                x2="19"
                y1="4"
                y2="4"
                strokeDasharray="2 3"
                className={`${styles.key} ${styles.keyExpiry}`}
              />
            </svg>
            {t('quota_management.pool_legend_reset_expiry')}
          </span>
        )}
      </div>
    </div>
  );
}
