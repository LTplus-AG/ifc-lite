/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Summary statistics for a completed BIM ↔ scan deviation run (#6872).
 *
 * The summary renders the stored run statistics (`pointCloudDeviationStatistics`,
 * derived once per readback by `DeviationPanel`, #6833); the histogram is a
 * single O(n) pass over the panel's held readback, so dragging the range
 * slider never re-runs the percentile selection.
 *
 * Every pass runs through the renderer's `…Async` variants: time-boxed
 * slices that yield to the event loop, so 25M points never freeze the
 * viewer, and an AbortSignal so a superseded pass (the next slider tick, a
 * new run, unmount) stops instead of finishing for nothing.
 */

import { useEffect, useState } from 'react';
import { deviationHistogramAsync, type DeviationDistances } from '@ifc-lite/renderer';
import type { PointCloudDeviationStatistics } from '@/lib/point-cloud/deviation-run-statistics';
import { formatLocaleNumber, useTranslation, type TranslationKey } from '@/i18n';
import { deviationRampColor } from '@/lib/point-cloud/deviation-ramp';

/** Even, so the ramp centre falls on a bin edge. */
const HISTOGRAM_BINS = 20;

/**
 * The latest result of a sliced pass. A change in `inputs` aborts the pass in
 * flight; until the new one lands the previous result stays on screen, so
 * results carry the inputs they were computed for where a label shows them.
 */
function useSlicedPass<T>(run: (signal: AbortSignal) => Promise<T>, inputs: readonly unknown[]): T | null {
  const [result, setResult] = useState<T | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    run(controller.signal).then(
      (value) => { if (!controller.signal.aborted) setResult(value); },
      (err: unknown) => { if (!controller.signal.aborted) console.error('[DeviationStatistics] pass failed', err); },
    );
    return () => controller.abort();
    // `inputs` lists everything `run` closes over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, inputs);
  return result;
}

/** Bars aligned with the legend gradient: same width, same [c − h, c + h]. */
export function DeviationHistogramBars({ distances, center, halfRange }: {
  distances: DeviationDistances;
  center: number;
  halfRange: number;
}) {
  const { t, locale } = useTranslation();
  const histogram = useSlicedPass(
    (signal) => deviationHistogramAsync(distances.values, { center, halfRange, bins: HISTOGRAM_BINS }, { signal }),
    [distances, center, halfRange],
  );
  // Hold the bars' height while the first pass runs, so the legend stays put.
  if (!histogram) return <div className="mt-1 h-8" aria-hidden="true" />;
  const peak = Math.max(1, ...histogram.counts);
  const mm = (m: number) => formatLocaleNumber(locale, m * 1000, { maximumFractionDigits: 1 });
  const count = (n: number) => formatLocaleNumber(locale, n);
  return (
    <>
      <figure className="mt-1" data-testid="deviation-histogram">
        <figcaption className="sr-only">
          {t('deviationStats.histogramAriaLabel', {
            min: mm(histogram.min), max: mm(histogram.max), bins: HISTOGRAM_BINS,
            below: count(histogram.below), above: count(histogram.above),
          })}
        </figcaption>
        <div className="flex items-end gap-px h-8" aria-hidden="true">
          {histogram.counts.map((binCount, i) => (
            <div
              key={i}
              className="flex-1 rounded-t-sm border-x border-t border-foreground/10"
              data-count={binCount}
              style={{
                height: `${(binCount / peak) * 100}%`,
                background: deviationRampColor(((i + 0.5) / HISTOGRAM_BINS) * 2 - 1),
              }}
            />
          ))}
        </div>
      </figure>
      {(histogram.below > 0 || histogram.above > 0) && (
        <span className="text-2xs text-muted-foreground">
          {t('deviationStats.outsideRange', { below: count(histogram.below), above: count(histogram.above) })}
        </span>
      )}
    </>
  );
}

type DistanceKey = 'mean' | 'meanAbs' | 'rms' | 'stdDev' | 'p50Abs' | 'p95Abs' | 'p99Abs' | 'maxAbs';

const SUMMARY_ROWS: ReadonlyArray<readonly [TranslationKey, DistanceKey]> = [
  ['deviationStats.mean', 'mean'],
  ['deviationStats.meanAbs', 'meanAbs'],
  ['deviationStats.rms', 'rms'],
  ['deviationStats.stdDev', 'stdDev'],
  ['deviationStats.p50Abs', 'p50Abs'],
  ['deviationStats.p95Abs', 'p95Abs'],
  ['deviationStats.p99Abs', 'p99Abs'],
  ['deviationStats.maxAbs', 'maxAbs'],
];

export interface DeviationSummaryProps {
  /** The stored run statistics; null while the readback is being summarised. */
  statistics: PointCloudDeviationStatistics | null;
  /** Metres; the panel owns it because the CSV export reports it too. */
  tolerance: number;
  onToleranceChange: (metres: number) => void;
  /** False when the readback is no longer held (panel remounted), so the band cannot be recounted. */
  toleranceEditable: boolean;
}

export function DeviationSummary({ statistics, tolerance, onToleranceChange, toleranceEditable }: DeviationSummaryProps) {
  const { t, locale } = useTranslation();
  const summary = statistics?.overall ?? null;
  const within = statistics?.withinTolerance ? { tolerance: statistics.withinTolerance.tolerance, count: statistics.withinTolerance.overall } : null;
  const clipRange = statistics?.clipRange ?? 0;
  const [draft, setDraft] = useState(() => String(tolerance * 1000));
  const mm = (m: number | null) => (m !== null
    ? t('deviationStats.valueMm', {
      value: formatLocaleNumber(locale, m * 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    })
    : t('deviationStats.notAvailable'));
  const count = (n: number) => formatLocaleNumber(locale, n);

  if (!summary) {
    return (
      <span className="text-2xs text-muted-foreground mt-1" data-testid="deviation-summary-pending">
        {t('deviationStats.reading')}
      </span>
    );
  }

  return (
    <section aria-label={t('deviationStats.sectionLabel')} className="flex flex-col gap-1 mt-1" data-testid="deviation-summary">
      <span className="text-2xs uppercase text-muted-foreground tracking-wider">
        {t('deviationStats.sectionLabel')}
      </span>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-2xs tabular-nums">
        <dt className="text-muted-foreground">{t('deviationStats.pointsMeasured')}</dt>
        <dd className="text-right">{count(summary.validCount)}</dd>
        {SUMMARY_ROWS.map(([label, key]) => (
          <div key={key} className="contents" data-stat={key}>
            <dt className="text-muted-foreground">{t(label)}</dt>
            <dd className="text-right">{mm(summary[key])}</dd>
          </div>
        ))}
      </dl>
      <label className="flex items-center gap-1 text-2xs text-muted-foreground">
        <span>{t('deviationStats.toleranceLabel')}</span>
        <input
          type="number"
          min={0}
          step={0.5}
          value={draft}
          disabled={!toleranceEditable}
          onChange={(e) => {
            setDraft(e.target.value);
            const value = Number(e.target.value);
            if (e.target.value.trim() !== '' && Number.isFinite(value) && value >= 0) onToleranceChange(value / 1000);
          }}
          aria-label={t('deviationStats.toleranceAriaLabel')}
          className="h-5 w-14 rounded border border-border bg-transparent px-1 text-right text-2xs tabular-nums text-foreground"
        />
        <span>{t('deviationStats.unitMm')}</span>
      </label>
      {within && (
        <span className="text-2xs" data-testid="deviation-within-tolerance">
          {t('deviationStats.withinTolerance', {
            share: summary.validCount > 0
              ? formatLocaleNumber(locale, within.count / summary.validCount, { style: 'percent', maximumFractionDigits: 1 })
              : t('deviationStats.notAvailable'),
            tolerance: formatLocaleNumber(locale, within.tolerance * 1000, { maximumFractionDigits: 1 }),
            count: count(within.count),
            total: count(summary.validCount),
          })}
        </span>
      )}
      {summary.clippedCount > 0 && (
        <span className="text-2xs text-muted-foreground">
          {t('deviationStats.clippedPoints', {
            count: summary.clippedCount,
            countDisplay: count(summary.clippedCount),
            clip: formatLocaleNumber(locale, clipRange),
          })}
        </span>
      )}
    </section>
  );
}
