/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Summary statistics for a completed BIM ↔ scan deviation run (#6872).
 *
 * Both blocks read the signed distances the panel read back once after the
 * compute pass. The |d| percentiles and moments are computed once per
 * readback; the tolerance share and the histogram are O(n) passes with no
 * allocation, so editing the tolerance or dragging the range slider never
 * re-runs the percentile selection.
 */

import { useMemo, useState } from 'react';
import {
  computeDeviationStatistics,
  countWithinTolerance,
  deviationHistogram,
  type DeviationDistances,
} from '@ifc-lite/renderer';
import { formatLocaleNumber, useTranslation, type TranslationKey } from '@/i18n';
import { deviationRampColor } from '@/lib/point-cloud/deviation-ramp';

/** Even, so the ramp centre falls on a bin edge. */
const HISTOGRAM_BINS = 20;

/** Bars aligned with the legend gradient: same width, same [c − h, c + h]. */
export function DeviationHistogramBars({ distances, center, halfRange }: {
  distances: DeviationDistances;
  center: number;
  halfRange: number;
}) {
  const { t, locale } = useTranslation();
  const histogram = useMemo(
    () => deviationHistogram(distances.values, { center, halfRange, bins: HISTOGRAM_BINS }),
    [distances, center, halfRange],
  );
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
  distances: DeviationDistances;
  /** Metres; the panel owns it because the CSV export reports it too. */
  tolerance: number;
  onToleranceChange: (metres: number) => void;
  /** The `maxRange` the compute pass clamped to, metres. */
  clipRange: number;
}

export function DeviationSummary({ distances, tolerance, onToleranceChange, clipRange }: DeviationSummaryProps) {
  const { t, locale } = useTranslation();
  const summary = useMemo(
    () => computeDeviationStatistics(distances.values, { clipRange }),
    [distances, clipRange],
  );
  const within = useMemo(() => countWithinTolerance(distances.values, tolerance), [distances, tolerance]);
  const [draft, setDraft] = useState(() => String(tolerance * 1000));
  const mm = (m: number | null) => (m !== null
    ? t('deviationStats.valueMm', {
      value: formatLocaleNumber(locale, m * 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    })
    : t('deviationStats.notAvailable'));
  const count = (n: number) => formatLocaleNumber(locale, n);

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
      <span className="text-2xs" data-testid="deviation-within-tolerance">
        {t('deviationStats.withinTolerance', {
          share: summary.validCount > 0
            ? formatLocaleNumber(locale, within / summary.validCount, { style: 'percent', maximumFractionDigits: 1 })
            : t('deviationStats.notAvailable'),
          tolerance: formatLocaleNumber(locale, tolerance * 1000, { maximumFractionDigits: 1 }),
          count: count(within),
          total: count(summary.validCount),
        })}
      </span>
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
