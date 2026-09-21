/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import type { LandXmlSourceModel, LandXmlSourceRecord, LandXmlSourceRef, LandXmlSuperelevation } from '@/hooks/ingest/landXmlSemantics';
import type { LandXmlAlignmentInspectionResult, LandXmlAlignmentProbeResult } from '@/hooks/ingest/landXmlAlignmentWasm';
import { probeLandXmlAlignmentInWorker } from '@/hooks/ingest/landXmlProbe';

const PAGE_SIZE = 100;
type AlignmentRecord = Extract<LandXmlSourceRecord, { kind: 'alignment' | 'alignment-segment' | 'unsupported-transition' }>;
type NavigationItem = { label: string; sourceId: string };
type SuperelevationEventItem = { sourceId: string; blockSourceId: string; label: string };

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
function navigationAt(record: AlignmentRecord, itemIndex: number): NavigationItem {
  const alignment = record.alignment;
  if (itemIndex === 0) return { label: `Alignment: ${alignment.name}`, sourceId: alignment.sourceId };
  let index = itemIndex - 1;
  const segment = alignment.segments[index];
  if (segment) return { label: `Segment ${segment.ordinal}: ${segment.primitive.kind}`, sourceId: segment.sourceId };
  index -= alignment.segments.length;
  const transition = alignment.unsupportedTransitions[index];
  if (transition) return { label: `Refused ${transition.spiType} transition: ${transition.reason}`, sourceId: transition.sourceId };
  throw new Error(`LandXML alignment navigation index ${itemIndex} is outside retained records`);
}
function recordName(record: AlignmentRecord): string {
  if (record.kind === 'alignment') return record.alignment.name;
  if (record.kind === 'alignment-segment') return `Segment ${record.segment.ordinal}`;
  return `Unsupported ${record.transition.spiType} transition`;
}

export function LandXmlAlignmentSourceInspector({ modelId, sourceFile, record, onSelect }: {
  modelId: string; sourceFile: LandXmlSourceModel['sourceFile']; record: AlignmentRecord;
  onSelect(ref: LandXmlSourceRef): void;
}) {
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
    const distance = Number(distanceInput), station = Number(stationInput), offset = Number(offsetInput);
    const valid = Number.isFinite(offset) && (mode === 'distance' ? Number.isFinite(distance) : Number.isFinite(station));
    if (!valid) {
      setProbe(null); setInspection(null); setError('Enter finite numeric probe values.');
      return () => { active = false; };
    }
    void sourceFile.arrayBuffer().then((buffer) => probeLandXmlAlignmentInWorker(buffer, {
      alignmentSourceId: alignment.sourceId, mode, value: mode === 'distance' ? distance : station, offsetRight: offset,
    }, controller.signal)).then(({ probes, inspection: result }) => {
      const first = probes[0];
      if (!first) throw new Error('The displayed station is in a station-equation gap.');
      if (active) { setProbe(first); setInspection(result); setError(probes.length > 1 ? `Station resolves to ${probes.length} physical distances; showing the first.` : null); }
    }).catch((cause: unknown) => {
      if (!active) return;
      console.error('[LandXmlAlignmentSourceInspector] probe failed:', cause);
      setProbe(null); setInspection(null); setError(cause instanceof Error ? cause.message : 'LandXML alignment probe failed.');
    });
    return () => { active = false; controller.abort(); };
  }, [alignment.sourceId, distanceInput, mode, offsetInput, sourceFile, stationInput]);

  const count = navigationCount(record), pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const page = Math.min(navigationPage, pages - 1), first = page * PAGE_SIZE;
  const items = Array.from({ length: Math.min(PAGE_SIZE, count - first) }, (_, index) => navigationAt(record, first + index));
  const internalStation = probe === null ? null : alignment.staStart + probe.distance;
  const applicableSuperelevations = internalStation === null ? [] : alignment.superelevations.filter((value) =>
    (value.staStart === null || internalStation >= value.staStart)
    && (value.staEnd === null || internalStation <= value.staEnd));
  const eventPage = superelevationEventPage(applicableSuperelevations, superelevationPage * PAGE_SIZE);
  const eventPages = Math.max(1, Math.ceil(eventPage.total / PAGE_SIZE));
  return <div className="h-full overflow-auto border-l-2 border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black" data-landxml-source-inspector>
    <div className="space-y-2 border-b-2 border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-black">
      <p className="text-xs font-bold uppercase tracking-wide text-zinc-500">LandXML Alignment</p>
      <h3 className="truncate text-sm font-bold uppercase tracking-tight text-zinc-900 dark:text-zinc-100">{recordName(record)}</h3>
      <p className="break-all font-mono text-xs text-zinc-500">{alignment.sourceId}</p>
    </div>
    <div className="divide-y divide-zinc-100 py-2 dark:divide-zinc-900">{items.map((item) => <button key={item.sourceId} type="button" className="block w-full px-4 py-2 text-left text-xs text-zinc-700 dark:text-zinc-300" onClick={() => onSelect({ modelId, sourceId: item.sourceId })}>{item.label}</button>)}</div>
    {pages > 1 && <div className="flex items-center justify-between border-t border-zinc-200 px-4 py-2 text-xs dark:border-zinc-800"><button type="button" disabled={page === 0} onClick={() => setNavigationPage(page - 1)}>Previous</button><span>{page + 1} / {pages}</span><button type="button" disabled={page + 1 >= pages} onClick={() => setNavigationPage(page + 1)}>Next</button></div>}
    <div className="space-y-2 p-4 text-xs text-zinc-700 dark:text-zinc-300">
      <p>Length: {alignment.length}</p><p>Start station: {alignment.staStart}</p><p>Segments: {alignment.segments.length}</p>
      {alignment.cant && <><p>Cant: {alignment.cant.name}; gauge {alignment.cant.gauge}; rotation point {alignment.cant.rotationPoint ?? 'unspecified'}</p><p>Cant constants: equilibrium {alignment.cant.equilibriumConstant ?? 'unspecified'}; applied {alignment.cant.appliedCantConstant ?? 'unspecified'}; speed stations {alignment.cant.speedStations.length}</p></>}
      <label className="block">Probe by <select aria-label="Probe mode" value={mode} onChange={(event) => setMode(event.target.value === 'station' ? 'station' : 'distance')}><option value="distance">geometric distance</option><option value="station">displayed station</option></select></label>
      {mode === 'distance' ? <label className="block">Distance <input aria-label="Geometric distance" type="number" value={distanceInput} onChange={(event) => setDistanceInput(event.target.value)} /></label> : <label className="block">Station <input aria-label="Displayed station" type="number" value={stationInput} onChange={(event) => setStationInput(event.target.value)} /></label>}
      <label className="block">Right offset <input aria-label="Right offset" type="number" value={offsetInput} onChange={(event) => setOffsetInput(event.target.value)} /></label>
      {error && <p role="alert" className="text-red-700 dark:text-red-300">Probe unavailable: {error}</p>}
      {probe && <><p>Probe: {probe.northing}, {probe.easting}</p><p>Displayed station: {probe.displayedBack} / {probe.displayedAhead}</p><p>Probe span: {probe.segmentSourceId}</p></>}
      {inspection && <><p>Authored CantStation bracket: {inspection.previousCantStation ? `${inspection.previousCantStation.station} (applied ${inspection.previousCantStation.appliedCant})` : 'none'} / {inspection.nextCantStation ? `${inspection.nextCantStation.station} (applied ${inspection.nextCantStation.appliedCant})` : 'none'}</p><p>Authored Superelevation events: {eventPage.total}</p>{eventPage.items.map((event) => <p key={event.sourceId}>{event.blockSourceId}: {event.label}</p>)}{eventPages > 1 && <div className="flex items-center justify-between"><button type="button" disabled={eventPage.page === 0} onClick={() => setSuperelevationPage(eventPage.page - 1)}>Previous events</button><span>{eventPage.page + 1} / {eventPages}</span><button type="button" disabled={eventPage.page + 1 >= eventPages} onClick={() => setSuperelevationPage(eventPage.page + 1)}>Next events</button></div>}</>}
    </div>
  </div>;
}
