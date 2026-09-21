/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import type { LandXmlSourceModel, LandXmlSourceRecord, LandXmlSourceRef, LandXmlSuperelevation } from '@/hooks/ingest/landXmlSemantics';
import type { LandXmlAlignmentInspectionResult, LandXmlAlignmentProbeResult } from '@/hooks/ingest/landXmlAlignmentWasm';
import { probeLandXmlAlignmentInWorker } from '@/hooks/ingest/landXmlProbe';
import { useTranslation, type UseTranslationResult } from '@/i18n';

const PAGE_SIZE = 100;
type AlignmentRecord = Extract<LandXmlSourceRecord, { kind: 'alignment' | 'alignment-segment' | 'unsupported-transition' }>;
type NavigationItem = { label: string; sourceId: string };
type SuperelevationEventItem = { sourceId: string; blockSourceId: string; label: string };
type Translate = UseTranslationResult['t'];

export function parseAlignmentProbeInputs(
  mode: 'distance' | 'station', distanceInput: string, stationInput: string, offsetInput: string,
): { value: number; offsetRight: number } | null {
  const numeric = (input: string): number | null => {
    if (input.trim() === '') return null;
    const value = Number(input);
    return Number.isFinite(value) ? value : null;
  };
  const value = numeric(mode === 'distance' ? distanceInput : stationInput);
  const offsetRight = numeric(offsetInput);
  return value === null || offsetRight === null ? null : { value, offsetRight };
}

export function superelevationEventPage(values: LandXmlSuperelevation[], offset: number): { total: number; page: number; items: SuperelevationEventItem[] } {
  const total = values.reduce((sum, value) => sum + value.events.length, 0);
  const lastPageOffset = total === 0 ? 0 : Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE;
  const boundedOffset = Math.min(Math.max(0, offset), lastPageOffset);
  const items: SuperelevationEventItem[] = [];
  let cursor = 0;
  for (const value of values) {
    const localStart = Math.max(0, boundedOffset - cursor);
    const available = value.events.length - localStart;
    if (available > 0 && items.length < PAGE_SIZE) {
      for (const event of value.events.slice(localStart, localStart + PAGE_SIZE - items.length)) {
        items.push({ sourceId: event.sourceId, blockSourceId: value.sourceId, label: `${event.kind}${event.value === null ? '' : `=${event.value}`}` });
      }
    }
    cursor += value.events.length;
    if (items.length === PAGE_SIZE) break;
  }
  return { total, page: boundedOffset / PAGE_SIZE, items };
}

function navigationCount(record: AlignmentRecord): number {
  return 1 + record.alignment.segments.length + record.alignment.unsupportedTransitions.length;
}
function navigationAt(record: AlignmentRecord, itemIndex: number, t: Translate): NavigationItem {
  const alignment = record.alignment;
  if (itemIndex === 0) return { label: t('properties.landXmlAlignment.navigationAlignment', { name: alignment.name }), sourceId: alignment.sourceId };
  let index = itemIndex - 1;
  const segment = alignment.segments[index];
  if (segment) return { label: t('properties.landXmlAlignment.navigationSegment', { ordinal: segment.ordinal, kind: segment.primitive.kind }), sourceId: segment.sourceId };
  index -= alignment.segments.length;
  const transition = alignment.unsupportedTransitions[index];
  if (transition) return { label: t('properties.landXmlAlignment.navigationRefused', { kind: transition.spiType, reason: transition.reason }), sourceId: transition.sourceId };
  throw new Error(`LandXML alignment navigation index ${itemIndex} is outside retained records`);
}
function recordName(record: AlignmentRecord, t: Translate): string {
  if (record.kind === 'alignment') return record.alignment.name;
  if (record.kind === 'alignment-segment') return t('properties.landXmlAlignment.segmentName', { ordinal: record.segment.ordinal });
  return t('properties.landXmlAlignment.unsupportedTransitionName', { kind: record.transition.spiType });
}

export function LandXmlAlignmentSourceInspector({ modelId, sourceFile, record, onSelect }: {
  modelId: string; sourceFile: LandXmlSourceModel['sourceFile']; record: AlignmentRecord;
  onSelect(ref: LandXmlSourceRef): void;
}) {
  const { t } = useTranslation();
  const [navigationPage, setNavigationPage] = useState(0);
  const [superelevationPage, setSuperelevationPage] = useState(0);
  const [probe, setProbe] = useState<LandXmlAlignmentProbeResult | null>(null);
  const [inspection, setInspection] = useState<LandXmlAlignmentInspectionResult | null>(null);
  const [mode, setMode] = useState<'distance' | 'station'>('distance');
  const [distanceInput, setDistanceInput] = useState('0');
  const [stationInput, setStationInput] = useState('');
  const [offsetInput, setOffsetInput] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const alignment = record.alignment;

  useEffect(() => { setNavigationPage(0); setSuperelevationPage(0); }, [modelId, alignment.sourceId]);
  useEffect(() => {
    if (!sourceFile) { setProbe(null); setInspection(null); return; }
    let active = true;
    const controller = new AbortController();
    const inputs = parseAlignmentProbeInputs(mode, distanceInput, stationInput, offsetInput);
    if (!inputs) {
      setProbe(null); setInspection(null); setError(t('properties.landXmlAlignment.invalidProbe'));
      return () => { active = false; };
    }
    void sourceFile.arrayBuffer().then((buffer) => probeLandXmlAlignmentInWorker(buffer, {
      alignmentSourceId: alignment.sourceId, mode, ...inputs,
    }, controller.signal)).then(({ probes, inspection: result }) => {
      const first = probes[0];
      if (!first) throw new Error(t('properties.landXmlAlignment.stationGap'));
      if (active) { setProbe(first); setInspection(result); setError(probes.length > 1 ? t('properties.landXmlAlignment.stationAmbiguous', { count: probes.length }) : null); }
    }).catch((cause: unknown) => {
      if (!active) return;
      console.error('[LandXmlAlignmentSourceInspector] probe failed:', cause);
      setProbe(null); setInspection(null); setError(cause instanceof Error ? cause.message : t('properties.landXmlAlignment.probeFailed'));
    });
    return () => { active = false; controller.abort(); };
  }, [alignment.sourceId, distanceInput, mode, offsetInput, sourceFile, stationInput, t]);

  const count = navigationCount(record), pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const page = Math.min(navigationPage, pages - 1), first = page * PAGE_SIZE;
  const items = Array.from({ length: Math.min(PAGE_SIZE, count - first) }, (_, index) => navigationAt(record, first + index, t));
  const internalStation = probe === null ? null : alignment.staStart + probe.distance;
  const applicableSuperelevations = internalStation === null ? [] : alignment.superelevations.filter((value) =>
    (value.staStart === null || internalStation >= value.staStart)
    && (value.staEnd === null || internalStation <= value.staEnd));
  const eventPage = superelevationEventPage(applicableSuperelevations, superelevationPage * PAGE_SIZE);
  const eventPages = Math.max(1, Math.ceil(eventPage.total / PAGE_SIZE));
  return <div className="h-full overflow-auto border-l-2 border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black" data-landxml-source-inspector>
    <div className="space-y-2 border-b-2 border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-black">
      <p className="text-xs font-bold uppercase tracking-wide text-zinc-500">{t('properties.landXmlAlignment.heading')}</p>
      <h3 className="truncate text-sm font-bold uppercase tracking-tight text-zinc-900 dark:text-zinc-100">{recordName(record, t)}</h3>
      <p className="break-all font-mono text-xs text-zinc-500">{alignment.sourceId}</p>
    </div>
    <div className="divide-y divide-zinc-100 py-2 dark:divide-zinc-900">{items.map((item) => <button key={item.sourceId} type="button" className="block w-full px-4 py-2 text-left text-xs text-zinc-700 dark:text-zinc-300" onClick={() => onSelect({ modelId, sourceId: item.sourceId })}>{item.label}</button>)}</div>
    {pages > 1 && <div className="flex items-center justify-between border-t border-zinc-200 px-4 py-2 text-xs dark:border-zinc-800"><button type="button" disabled={page === 0} onClick={() => setNavigationPage(page - 1)}>{t('properties.landXmlSource.previous')}</button><span>{page + 1} / {pages}</span><button type="button" disabled={page + 1 >= pages} onClick={() => setNavigationPage(page + 1)}>{t('properties.landXmlSource.next')}</button></div>}
    <div className="space-y-2 p-4 text-xs text-zinc-700 dark:text-zinc-300">
      <p>{t('properties.landXmlAlignment.length', { value: alignment.length })}</p><p>{t('properties.landXmlAlignment.startStation', { value: alignment.staStart })}</p><p>{t('properties.landXmlAlignment.segments', { count: alignment.segments.length })}</p>
      {alignment.cant && <><p>{t('properties.landXmlAlignment.cant', { name: alignment.cant.name, gauge: alignment.cant.gauge, rotationPoint: alignment.cant.rotationPoint ?? t('properties.landXmlAlignment.unspecified') })}</p><p>{t('properties.landXmlAlignment.cantConstants', { equilibrium: alignment.cant.equilibriumConstant ?? t('properties.landXmlAlignment.unspecified'), applied: alignment.cant.appliedCantConstant ?? t('properties.landXmlAlignment.unspecified'), count: alignment.cant.speedStations.length })}</p></>}
      <label className="block">{t('properties.landXmlAlignment.probeBy')} <select aria-label={t('properties.landXmlAlignment.probeMode')} value={mode} onChange={(event) => setMode(event.target.value === 'station' ? 'station' : 'distance')}><option value="distance">{t('properties.landXmlAlignment.geometricDistance')}</option><option value="station">{t('properties.landXmlAlignment.displayedStationMode')}</option></select></label>
      {mode === 'distance' ? <label className="block">{t('properties.landXmlAlignment.distance')} <input aria-label={t('properties.landXmlAlignment.geometricDistanceLabel')} type="number" value={distanceInput} onChange={(event) => setDistanceInput(event.target.value)} /></label> : <label className="block">{t('properties.landXmlAlignment.station')} <input aria-label={t('properties.landXmlAlignment.displayedStationLabel')} type="number" value={stationInput} onChange={(event) => setStationInput(event.target.value)} /></label>}
      <label className="block">{t('properties.landXmlAlignment.rightOffset')} <input aria-label={t('properties.landXmlAlignment.rightOffset')} type="number" value={offsetInput} onChange={(event) => setOffsetInput(event.target.value)} /></label>
      {error && <p role="alert" className="text-red-700 dark:text-red-300">{t('properties.landXmlAlignment.probeUnavailable', { error })}</p>}
      {probe && <><p>{t('properties.landXmlAlignment.probe', { northing: probe.northing, easting: probe.easting })}</p><p>{t('properties.landXmlAlignment.displayedStation', { back: probe.displayedBack, ahead: probe.displayedAhead })}</p><p>{t('properties.landXmlAlignment.probeSpan', { sourceId: probe.segmentSourceId })}</p></>}
      {inspection && <><p>{t('properties.landXmlAlignment.cantBracket', { previous: inspection.previousCantStation ? t('properties.landXmlAlignment.appliedCant', { station: inspection.previousCantStation.station, applied: inspection.previousCantStation.appliedCant }) : t('properties.landXmlSource.none'), next: inspection.nextCantStation ? t('properties.landXmlAlignment.appliedCant', { station: inspection.nextCantStation.station, applied: inspection.nextCantStation.appliedCant }) : t('properties.landXmlSource.none') })}</p><p>{t('properties.landXmlAlignment.superelevationEvents', { count: eventPage.total })}</p>{eventPage.items.map((event) => <p key={event.sourceId}>{event.blockSourceId}: {event.label}</p>)}{eventPages > 1 && <div className="flex items-center justify-between"><button type="button" disabled={eventPage.page === 0} onClick={() => setSuperelevationPage(eventPage.page - 1)}>{t('properties.landXmlAlignment.previousEvents')}</button><span>{eventPage.page + 1} / {eventPages}</span><button type="button" disabled={eventPage.page + 1 >= eventPages} onClick={() => setSuperelevationPage(eventPage.page + 1)}>{t('properties.landXmlAlignment.nextEvents')}</button></div>}</>}
    </div>
  </div>;
}
