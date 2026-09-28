/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { QuantityType } from '@ifc-lite/data';
import { ProjectUnits } from '@ifc-lite/parser';
import type { SweptDiskDescriptions } from '@ifc-lite/geometry';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { useSelectedSweptDisks } from '@/hooks/useSelectedSweptDisks';
import { sameDirectrixSegment, type SelectedDirectrixSegment } from '@/lib/analytic/segment-selection';
import { resolveQuantityDisplay } from '@/lib/units/display';

type Occurrence = SweptDiskDescriptions['elements'][string][number];
const METRE_UNITS = ProjectUnits.empty();

/** Source measurements are already in metres; file units must not scale them again. */
export function formatAnalyticLength(metres: number, overrides: Record<string, string>): string {
  const display = resolveQuantityDisplay(metres, QuantityType.Length, METRE_UNITS, overrides);
  let amount = display.converted ?? metres;
  let unit = display.unit ?? 'm';
  if (display.converted === null) {
    const magnitude = Math.abs(metres);
    if (magnitude < 0.01) { amount = metres * 1_000; unit = 'mm'; }
    else if (magnitude < 1) { amount = metres * 100; unit = 'cm'; }
    else if (magnitude >= 1_000) { amount = metres / 1_000; unit = 'km'; }
  }
  return `${amount.toLocaleString(undefined, { maximumSignificantDigits: 11 })} ${unit}`;
}

function formatRadians(value: number): string {
  return `${value.toLocaleString(undefined, { maximumSignificantDigits: 11 })} rad`;
}

export function SweptDiskRecord({ occurrence, occurrenceIndex, modelId, expressId }: {
  occurrence: Occurrence;
  occurrenceIndex: number;
  modelId: string;
  expressId: number;
}) {
  const { t } = useTranslation();
  const overrides = useViewerStore((state) => state.unitDisplayOverrides);
  const selected = useViewerStore((state) => state.selectedDirectrixSegment);
  const select = useViewerStore((state) => state.setSelectedDirectrixSegment);
  const showOverlay = useViewerStore((state) => state.setCentrelineOverlayEnabled);
  const metrics = occurrence.directrix_metrics;
  const complete = occurrence.status.type === 'complete';
  return (
    <section className="border border-zinc-200 dark:border-zinc-800 p-2 space-y-1 text-xs" aria-label={t('properties.sweptDisk.solid', { id: occurrence.solid_id })}>
      <div className="font-semibold">{t('properties.sweptDisk.solid', { id: occurrence.solid_id })}</div>
      <div>{t('properties.sweptDisk.status')}: {complete ? t('properties.sweptDisk.complete') : t('properties.sweptDisk.unsupported')}</div>
      {occurrence.status.type === 'unsupported' && <output>{occurrence.status.reason}</output>}
      <div>{t('properties.sweptDisk.sourceModified')}: {occurrence.source_modified ? t('properties.sweptDisk.yes') : t('properties.sweptDisk.no')}</div>
      {occurrence.source_modified && <p className="text-amber-700 dark:text-amber-400">{t('properties.sweptDisk.modifiedHint')}</p>}
      <div>{t('properties.sweptDisk.directrix')}: #{occurrence.directrix_id}</div>
      <div className="break-all">{t('properties.sweptDisk.mappingPath')}: {occurrence.mapping_path.length ? occurrence.mapping_path.map((id) => `#${id}`).join(' → ') : t('properties.sweptDisk.none')}</div>
      <div>{t('properties.sweptDisk.radius')}: {formatAnalyticLength(occurrence.Radius, overrides)}</div>
      <div>{t('properties.sweptDisk.innerRadius')}: {occurrence.InnerRadius === null ? t('properties.sweptDisk.none') : formatAnalyticLength(occurrence.InnerRadius, overrides)}</div>
      {!complete && <p className="text-zinc-500">{t('properties.sweptDisk.unsupportedRadiusHint')}</p>}
      {metrics && <>
        <div className="font-medium pt-1">{t('properties.sweptDisk.derivedCentreline')}</div>
        <div>{t('properties.sweptDisk.totalLength')}: {formatAnalyticLength(metrics.total_length, overrides)}</div>
        <ol className="space-y-1">
          {metrics.segments.map((metric) => {
            const segment = occurrence.Directrix[metric.segment_index];
            if (!segment) return null;
            const target: SelectedDirectrixSegment = { modelId, expressId, occurrenceIndex, segmentIndex: metric.segment_index };
            const isSelected = sameDirectrixSegment(selected, target);
            return <li key={metric.segment_index}>
              <button
                type="button"
                aria-pressed={isSelected}
                disabled={occurrence.source_modified}
                title={occurrence.source_modified ? t('properties.sweptDisk.modifiedHighlightHint') : undefined}
                onClick={() => {
                  select(isSelected ? null : target);
                  if (!isSelected) showOverlay(true);
                }}
                className={`w-full text-left rounded px-1 py-1 border disabled:cursor-not-allowed disabled:opacity-60 ${isSelected ? 'border-amber-500 bg-amber-100 dark:bg-amber-900/30' : 'border-transparent hover:bg-zinc-100 dark:hover:bg-zinc-900'}`}
              >
                {t('properties.sweptDisk.segment', { index: metric.segment_index + 1 })} · {segment.type} · {formatAnalyticLength(metric.length, overrides)}
                {segment.type === 'arc' && <span className="block pl-2">
                  {t('properties.sweptDisk.bend')}: {formatRadians(metric.bend_angle ?? Math.abs(segment.sweep_angle))} · {t('properties.sweptDisk.signedSweep')}: {formatRadians(segment.sweep_angle)}
                </span>}
              </button>
            </li>;
          })}
        </ol>
      </>}
    </section>
  );
}

/** Shared by the Properties quantities tab and the Measure tool's source readout. */
export function SweptDiskInspection({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const { items, loading, error } = useSelectedSweptDisks(enabled);
  if (!enabled) return null;
  const withRecords = items.filter((item) => item.occurrences.length || item.diagnostics.length);
  return <section className="space-y-2" aria-label={t('properties.sweptDisk.heading')}>
    <h3 className="text-xs font-semibold uppercase tracking-wide">{t('properties.sweptDisk.heading')}</h3>
    <p className="text-2xs text-zinc-500">{t('properties.sweptDisk.sourceNote')}</p>
    {loading && <output className="block">{t('properties.sweptDisk.loading')}</output>}
    {error && <p role="alert">{error}</p>}
    {!loading && !error && withRecords.length === 0 && <p className="text-xs text-zinc-500">{t('properties.sweptDisk.empty')}</p>}
    {withRecords.map((item) => <div key={`${item.ref.modelId}:${item.ref.expressId}`} className="space-y-2">
      <div className="font-mono text-2xs">{item.ref.modelId} · #{item.ref.expressId}</div>
      {item.occurrences.map((occurrence, index) => <SweptDiskRecord
        key={`${occurrence.solid_id}:${index}`}
        occurrence={occurrence}
        occurrenceIndex={index}
        modelId={item.ref.modelId}
        expressId={item.ref.expressId}
      />)}
      {item.diagnostics.map((message, index) => <p key={index} role="alert" className="text-xs break-words text-amber-700 dark:text-amber-400">{message}</p>)}
    </div>)}
  </section>;
}
