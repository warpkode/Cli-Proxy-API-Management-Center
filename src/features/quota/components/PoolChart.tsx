/**
 * Pool time-series chart: solid recorded history up to "Now", dashed projection
 * after it, "+X%" step-up annotations at resets, optional per-account lines.
 *
 * Layout only; the series come from pool/poolView.ts. Hover and keyboard share
 * one cursor that snaps to drawn points (arrow keys step, Shift+arrow jumps
 * about a day, Home/End go to the ends, Escape clears).
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

export interface PoolChartAccountLine {
  key: string;
  color: string;
  label: string;
  masked: boolean;
  recorded: SeriesPoint[];
  projected: SeriesPoint[];
}

export interface PoolChartProps {
  range: TimeRange;
  nowMs: number;
  yMax: number;
  /** Series color (provider hue). Text never takes it. */
  color: string;
  recorded: SeriesPoint[];
  projected: SeriesPoint[];
  recordedStepUps?: readonly StepUpEvent[];
  projectedStepUps?: readonly StepUpEvent[];
  accountLines?: readonly PoolChartAccountLine[];
  emptyAtMs?: number | null;
  /** Gaps in recorded data longer than this lift the pen. */
  maxGapMs: number;
  /** Legend title: what the line measures. */
  seriesLabel: string;
  formatTick: (value: number) => string;
  /** Tooltip value, e.g. `398% left` or `3.7%/h`. */
  formatReadout: (value: number) => string;
  ariaLabel: string;
  /** Width used before the first measurement (and in static renders). */
  initialWidth?: number;
}

const HEIGHT = 300;
const MARGINS = { top: 36, right: 14, bottom: 30, left: 52 };
const DAY_LABEL_MIN_PX = 46;

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

const valueAt = (points: readonly SeriesPoint[], t: number): number | null => {
  if (points.length === 0 || t < points[0].t || t > points[points.length - 1].t) return null;
  let best = points[0];
  for (const point of points) {
    if (Math.abs(point.t - t) <= Math.abs(best.t - t)) best = point;
    if (point.t > t) break;
  }
  return best.value;
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
    accountLines = [],
    emptyAtMs = null,
    maxGapMs,
    seriesLabel,
    formatTick,
    formatReadout,
    ariaLabel,
    initialWidth = 960,
  } = props;
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const clipId = `pool-clip-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
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
    () => createScale(range, yMax, width, HEIGHT, MARGINS),
    [range, yMax, width]
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
      recordedArea: areaPath(recorded, scale, maxGapMs),
      projectedArea: areaPath(projected, scale, maxGapMs),
      recordedLine: linePath(recorded, scale, maxGapMs),
      projectedLine: linePath(projected, scale, maxGapMs),
      accounts: accountLines.map((line) => ({
        key: line.key,
        color: line.color,
        recorded: linePath(line.recorded, scale, maxGapMs),
        projected: linePath(line.projected, scale, maxGapMs),
      })),
    }),
    [recorded, projected, accountLines, scale, maxGapMs]
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
    return [
      ...placeStepLabels(recordedStepUps, recorded, scale, {
        minAmount: 5,
        minGapPx: 34,
        format,
      }),
      ...placeStepLabels(projectedStepUps, projected, scale, {
        minAmount: 1,
        minGapPx: 34,
        format,
      }),
    ];
  }, [recordedStepUps, projectedStepUps, recorded, projected, scale]);

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

  const tooltipOnLeft = hoverX > width * 0.62;
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
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={plot.left} y={plot.top - 2} width={plot.width} height={plot.height + 4} />
            </clipPath>
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
                x={plot.left - 8}
                y={scale.y(value)}
                dominantBaseline="middle"
              >
                {formatTick(value)}
              </text>
            </g>
          ))}

          <g clipPath={`url(#${clipId})`}>
            <path className={styles.area} d={paths.recordedArea} fill={color} />
            <path className={styles.area} d={paths.projectedArea} fill={color} />
            {paths.accounts.map((line) => (
              <g key={line.key}>
                <path className={styles.accountRecorded} d={line.recorded} stroke={line.color} />
                <path
                  className={styles.accountProjected}
                  d={line.projected}
                  stroke={line.color}
                  strokeDasharray="3 4"
                />
              </g>
            ))}
            <path className={styles.recorded} d={paths.recordedLine} stroke={color} />
            <path
              className={styles.projected}
              d={paths.projectedLine}
              stroke={color}
              strokeDasharray="6 5"
            />
          </g>

          {nowInRange && (
            <g>
              <line
                className={styles.nowLine}
                x1={scale.x(nowMs)}
                x2={scale.x(nowMs)}
                y1={plot.top - 14}
                y2={plotBottom + 6}
              />
              <text className={styles.nowLabel} x={scale.x(nowMs)} y={plot.top - 20}>
                {t('quota_management.pool_now')}
              </text>
              {liveValue !== null && (
                <circle
                  className={styles.dot}
                  cx={scale.x(nowMs)}
                  cy={scale.y(liveValue)}
                  r={4}
                  fill={color}
                />
              )}
            </g>
          )}

          {stepLabels.map((label) => (
            <text key={label.key} className={styles.stepLabel} x={label.x} y={label.y}>
              {label.text}
            </text>
          ))}

          {emptyVisible && emptyX !== null && (
            <g>
              <circle
                className={styles.emptyMarker}
                cx={emptyX}
                cy={scale.y(0)}
                r={5}
                stroke={color}
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
              />
              <circle
                className={styles.dot}
                cx={hoverX}
                cy={scale.y(hover.value)}
                r={4}
                fill={color}
              />
            </g>
          )}
        </svg>

        <div
          role="status"
          className={hover ? styles.tooltip : styles.srOnly}
          style={
            hover
              ? {
                  left: hoverX,
                  top: plot.top,
                  transform: tooltipOnLeft ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
                }
              : undefined
          }
        >
          {hover && (
            <>
              <div className={styles.tooltipHead}>
                {formatInstant(hover.t, nowMs, locale)} ·{' '}
                <strong>{formatReadout(hover.value)}</strong> · {readoutKind(hover.kind)}
              </div>
              {accountLines.map((line) => {
                const series = hover.kind === 'recorded' ? line.recorded : line.projected;
                const value = valueAt(series, hover.t);
                if (value === null) return null;
                return (
                  <div key={line.key} className={styles.tooltipRow}>
                    <span className={styles.lineKey} style={{ background: line.color }} />
                    <span className={line.masked ? styles.masked : styles.tooltipLabel}>
                      {line.label}
                    </span>
                    <span className={styles.tooltipValue}>{formatPercent(value)}</span>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>

      <div className={styles.legend}>
        <span className={styles.legendTitle}>{seriesLabel}</span>
        <span className={styles.legendItem}>
          <svg width="18" height="8" aria-hidden="true" focusable="false">
            <line x1="1" x2="17" y1="4" y2="4" stroke={color} className={styles.keyRecorded} />
          </svg>
          {t('quota_management.pool_legend_recorded')}
        </span>
        <span className={styles.legendItem}>
          <svg width="18" height="8" aria-hidden="true" focusable="false">
            <line
              x1="1"
              x2="17"
              y1="4"
              y2="4"
              stroke={color}
              strokeDasharray="4 3"
              className={styles.keyProjected}
            />
          </svg>
          {t('quota_management.pool_legend_projected')}
        </span>
        {accountLines.map((line) => (
          <span key={line.key} className={styles.legendItem}>
            <svg width="18" height="8" aria-hidden="true" focusable="false">
              <line
                x1="1"
                x2="17"
                y1="4"
                y2="4"
                stroke={line.color}
                className={styles.keyAccount}
              />
            </svg>
            <span className={line.masked ? styles.masked : undefined}>{line.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
