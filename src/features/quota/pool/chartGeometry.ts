/**
 * Pixel geometry for the pool chart. Pure: no DOM, no React.
 */

import { nearestPoint, type TimeRange } from './poolModel';
import type { SeriesPoint, StepUpEvent } from './types';

const STEP_LABEL_TOLERANCE_MS = 30 * 60_000;

export interface ChartMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ChartScale {
  plot: { left: number; top: number; width: number; height: number };
  x: (t: number) => number;
  y: (value: number) => number;
  invertX: (px: number) => number;
}

/** Tenth-of-a-pixel precision keeps the markup small without visible error. */
const round1 = (value: number) => Math.round(value * 10) / 10;

export function createScale(
  range: TimeRange,
  yMax: number,
  width: number,
  height: number,
  margins: ChartMargins
): ChartScale {
  const plot = {
    left: margins.left,
    top: margins.top,
    width: Math.max(1, width - margins.left - margins.right),
    height: Math.max(1, height - margins.top - margins.bottom),
  };
  const span = Math.max(1, range.endMs - range.startMs);
  const top = yMax > 0 ? yMax : 1;
  return {
    plot,
    x: (t) => round1(plot.left + ((t - range.startMs) / span) * plot.width),
    y: (value) =>
      round1(plot.top + plot.height - (Math.min(top, Math.max(0, value)) / top) * plot.height),
    invertX: (px) => range.startMs + ((px - plot.left) / plot.width) * span,
  };
}

const fmt = (value: number) => round1(value).toString();

/** Polyline path that lifts the pen across gaps longer than `maxGapMs`. */
export function linePath(
  points: readonly SeriesPoint[],
  scale: ChartScale,
  maxGapMs: number
): string {
  let path = '';
  let previous: SeriesPoint | null = null;
  for (const point of points) {
    const command = previous && point.t - previous.t <= maxGapMs ? 'L' : 'M';
    path += `${command}${fmt(scale.x(point.t))},${fmt(scale.y(point.value))}`;
    previous = point;
  }
  return path;
}

/** Closed area under each continuous run of the line. */
export function areaPath(
  points: readonly SeriesPoint[],
  scale: ChartScale,
  maxGapMs: number
): string {
  const baseline = fmt(scale.y(0));
  let path = '';
  let run: SeriesPoint[] = [];
  const flush = () => {
    if (run.length < 2) {
      run = [];
      return;
    }
    path += `M${fmt(scale.x(run[0].t))},${baseline}`;
    for (const point of run) path += `L${fmt(scale.x(point.t))},${fmt(scale.y(point.value))}`;
    path += `L${fmt(scale.x(run[run.length - 1].t))},${baseline}Z`;
    run = [];
  };
  for (const point of points) {
    const previous = run[run.length - 1];
    if (previous && point.t - previous.t > maxGapMs) flush();
    run.push(point);
  }
  flush();
  return path;
}

export interface StepLabel {
  key: string;
  x: number;
  y: number;
  text: string;
}

/**
 * "+X%" labels above each step-up, skipping tiny steps and any label that would
 * collide with the previous one.
 */
export function placeStepLabels(
  events: readonly StepUpEvent[],
  series: readonly SeriesPoint[],
  scale: ChartScale,
  options: { minAmount: number; minGapPx: number; format: (amount: number) => string }
): StepLabel[] {
  const labels: StepLabel[] = [];
  let lastX = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    if (event.amount < options.minAmount) continue;
    const x = scale.x(event.t);
    if (x < scale.plot.left || x > scale.plot.left + scale.plot.width) continue;
    if (x - lastX < options.minGapPx) continue;
    // Label the top of the step: the highest value drawn just after the instant
    // (downsampling may have moved the exact step points within their bucket).
    let top = Number.NEGATIVE_INFINITY;
    for (const point of series) {
      if (point.t >= event.t && point.t <= event.t + STEP_LABEL_TOLERANCE_MS) {
        top = Math.max(top, point.value);
      }
    }
    if (!Number.isFinite(top)) top = nearestPoint(series, event.t)?.value ?? Number.NaN;
    if (!Number.isFinite(top)) continue;
    labels.push({
      key: `${event.t}`,
      x,
      y: Math.max(10, scale.y(top) - 8),
      text: options.format(event.amount),
    });
    lastX = x;
  }
  return labels;
}
