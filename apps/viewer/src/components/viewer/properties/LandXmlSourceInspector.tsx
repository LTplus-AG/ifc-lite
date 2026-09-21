/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@/i18n';
import type { UseTranslationResult } from '@/i18n';
import {
  findLandXmlModelSourceRecord,
  landXmlPlanChildPage,
  type LandXmlSourceModel,
  type LandXmlSourceRecord,
  type LandXmlSourceRef,
} from '@/hooks/ingest/landXmlSemantics';
import {
  type LandXmlAlignmentInspectionResult,
  type LandXmlAlignmentProbeResult,
} from '@/hooks/ingest/landXmlAlignmentWasm';
import { probeLandXmlAlignmentInWorker } from '@/hooks/ingest/landXmlProbe';
import { semanticDetailRows, semanticNavigationAt, semanticNavigationCount } from './landXmlSemanticInspection.js';

interface LandXmlSourceInspectorProps {
  models: ReadonlyMap<string, LandXmlSourceModel>;
  selected: LandXmlSourceRef;
  onSelect(ref: LandXmlSourceRef): void;
}

type Translate = UseTranslationResult['t'];

function recordName(record: LandXmlSourceRecord, t: Translate): string {
  switch (record.kind) {
    case 'surface': return record.surface.name;
    case 'point': return record.point.id;
    case 'source-data-point': return t('properties.landXmlSource.sourcePointName', { ordinal: record.point.ordinal });
    case 'face': return record.pointIds.join(', ');
    case 'alignment-segment': return `Segment ${record.segment.ordinal}`;
    case 'unsupported-transition': return `Unsupported ${record.transition.spiType} transition`;
    case 'boundary': case 'breakline': case 'contour': return record.line.name ?? record.line.sourceId;
    case 'pipe': return record.pipe.name;
    case 'pipe-structure': return record.structure.name;
    case 'pipe-feature': return record.feature.sourceId;
    case 'alignment': return record.alignment.name;
    case 'profile': return record.profile.name;
    case 'profile-point': return `PVI: sta ${record.point.station}`;
    case 'vertical-curve': return `${record.curve.kind}: sta ${record.curve.station}`;
    case 'grade-line': return `Grade line ${record.gradeLine.ordinal}`;
    case 'grade-line-point': return `Grade sample: sta ${record.point.station}`;
    case 'cross-section': return `Cross section ${record.crossSection.ordinal}`;
    case 'cross-section-surface': return record.crossSectionSurface.name || record.crossSectionSurface.sourceId;
    case 'cross-section-segment': return `Cross-section segment ${record.segment.ordinal}`;
    case 'cross-section-point': return `Cross-section point ${record.point.sourceId}`;
    case 'roadway': return record.roadway.name;
    case 'preserved-extension': return record.extension.localName;
    case 'cogo-point': return record.point.name ?? record.point.sourceId;
    case 'monument': return record.monument.name ?? record.monument.sourceId;
    case 'plan-feature': return record.feature.name ?? record.feature.sourceId;
    case 'parcel': return record.parcel.name ?? record.parcel.sourceId;
    case 'plan-geometry': return t('properties.landXmlSource.geometryName', { kind: record.geometry.kind, ordinal: record.geometry.ordinal });
    case 'pipe-network': return record.network.name;
    case 'pipe-network-collection': return record.collection.sourceId;
  }
}

function recordPath(record: LandXmlSourceRecord): string {
  switch (record.kind) {
    case 'surface': return record.surface.sourcePath;
    case 'point': return `${record.surface.sourcePath}/Definition/Pnts/P[@id="${record.point.id}"]`;
    case 'face': return `${record.surface.sourcePath}/Definition/Faces/F`;
    case 'source-data-point': return record.point.sourcePath;
    case 'alignment-segment': return `LandXML/Alignments/Alignment[${record.alignment.ordinal}]/CoordGeom`;
    case 'unsupported-transition': return `LandXML/Alignments/Alignment[${record.alignment.ordinal}]/CoordGeom`;
    case 'boundary': case 'breakline': case 'contour': return record.line.sourcePath;
    case 'pipe': return record.pipe.sourcePath;
    case 'pipe-structure': return record.structure.sourcePath;
    case 'pipe-feature': return record.feature.sourcePath;
    case 'alignment': return record.alignment.sourceId;
    case 'profile': return record.profile.sourceId;
    case 'profile-point': return record.point.sourceId;
    case 'vertical-curve': return record.curve.sourceId;
    case 'grade-line': return record.gradeLine.sourceId;
    case 'grade-line-point': return record.point.sourceId;
    case 'cross-section': return record.crossSection.sourceId;
    case 'cross-section-surface': return record.crossSectionSurface.sourceId;
    case 'cross-section-segment': return record.segment.sourceId;
    case 'cross-section-point': return record.point.sourceId;
    case 'roadway': return record.roadway.sourceId;
    case 'preserved-extension': return record.extension.sourcePath;
    case 'cogo-point': return record.point.sourceId;
    case 'monument': return record.monument.sourceId;
    case 'plan-feature': return record.feature.sourceId;
    case 'parcel': return record.parcel.sourceId;
    case 'plan-geometry': return record.geometry.sourceId;
    case 'pipe-network': return record.network.sourcePath;
    case 'pipe-network-collection': return record.collection.sourcePath;
  }
}

const NAVIGATION_PAGE_SIZE = 100;

type NavigationItem = { label: string; sourceId: string };
type LandXmlSurfaceRecord = Extract<LandXmlSourceRecord, { kind: 'surface' }>['surface'];

function navigationCount(surface: LandXmlSurfaceRecord): number {
  return 1 + surface.points.length + surface.sourceDataPoints.length + surface.faceSourceIds.length
    + surface.boundaries.length + surface.breaklines.length + surface.contours.length;
}

/** Materialize one page only: survey surfaces may contain millions of points. */
function navigationAt(surface: LandXmlSurfaceRecord, itemIndex: number, t: Translate): NavigationItem {
  if (itemIndex === 0) return { label: t('properties.landXmlSource.navigationSurface', { name: surface.name }), sourceId: surface.sourceId };
  let index = itemIndex - 1;
  const point = surface.points[index];
  if (point) return { label: t('properties.landXmlSource.navigationPoint', { id: point.id }), sourceId: point.sourceId };
  index -= surface.points.length;
  const sourcePoint = surface.sourceDataPoints[index];
  if (sourcePoint) return { label: t('properties.landXmlSource.sourcePointName', { ordinal: sourcePoint.ordinal }), sourceId: sourcePoint.sourceId };
  index -= surface.sourceDataPoints.length;
  const faceSourceId = surface.faceSourceIds[index];
  if (faceSourceId) return { label: t('properties.landXmlSource.navigationFace', { ordinal: index + 1 }), sourceId: faceSourceId };
  index -= surface.faceSourceIds.length;
  const boundary = surface.boundaries[index];
  if (boundary) return { label: t('properties.landXmlSource.navigationBoundary', { name: boundary.name ?? boundary.ordinal }), sourceId: boundary.sourceId };
  index -= surface.boundaries.length;
  const breakline = surface.breaklines[index];
  if (breakline) return { label: t('properties.landXmlSource.navigationBreakline', { name: breakline.name ?? breakline.ordinal }), sourceId: breakline.sourceId };
  index -= surface.breaklines.length;
  const contour = surface.contours[index];
  if (contour) return { label: t('properties.landXmlSource.navigationContour', { name: contour.name ?? contour.ordinal }), sourceId: contour.sourceId };
  throw new Error(`LandXML source navigation index ${itemIndex} is outside the retained surface records`);
}

function alignmentNavigationCount(alignment: Extract<LandXmlSourceRecord, { kind: 'alignment' }>['alignment']): number {
  return 1 + alignment.segments.length + alignment.unsupportedTransitions.length;
}

function alignmentNavigationAt(
  alignment: Extract<LandXmlSourceRecord, { kind: 'alignment' }>['alignment'], itemIndex: number,
): NavigationItem {
  if (itemIndex === 0) return { label: `Alignment: ${alignment.name}`, sourceId: alignment.sourceId };
  let index = itemIndex - 1;
  const segment = alignment.segments[index];
  if (segment) return { label: `Segment ${segment.ordinal}: ${segment.primitive.kind}`, sourceId: segment.sourceId };
  index -= alignment.segments.length;
  const transition = alignment.unsupportedTransitions[index];
  if (transition) return { label: `Refused ${transition.spiType} transition: ${transition.reason}`, sourceId: transition.sourceId };
  throw new Error(`LandXML alignment navigation index ${itemIndex} is outside the retained alignment records`);
}

function surfacePropertyRows(properties: Record<string, string>): Array<readonly [string, string]> {
  return Object.entries(properties).sort(([left], [right]) => left.localeCompare(right));
}

function terrainRecord(record: LandXmlSourceRecord): record is Extract<LandXmlSourceRecord, { surface: unknown }> {
  return 'surface' in record;
}

type PlanRecord = Extract<LandXmlSourceRecord, { kind: 'cogo-point' | 'monument' | 'plan-feature' | 'parcel' | 'plan-geometry' }>;

function planRecord(record: LandXmlSourceRecord): record is PlanRecord {
  return record.kind === 'cogo-point' || record.kind === 'monument' || record.kind === 'plan-feature'
    || record.kind === 'parcel' || record.kind === 'plan-geometry';
}

function planProperties(record: PlanRecord): Record<string, string> {
  switch (record.kind) {
    case 'cogo-point': return record.point.properties;
    case 'monument': return record.monument.properties;
    case 'plan-feature': return record.feature.properties;
    case 'parcel': return record.parcel.properties;
    case 'plan-geometry': return record.geometry.properties;
  }
}

function planNavigation(record: LandXmlSourceRecord, offset: number, t: Translate): { total: number; items: NavigationItem[] } {
  if (record.kind !== 'plan-feature' && record.kind !== 'parcel') return { total: 0, items: [] };
  const page = landXmlPlanChildPage(record, offset, NAVIGATION_PAGE_SIZE);
  return { total: page.total, items: page.sourceIds.map((sourceId) => ({ label: t('properties.landXmlSource.navigationGeometry', { sourceId }), sourceId })) };
}

function pointText(point: { northing: number; easting: number; elevation: number | null }): string {
  return point.elevation === null
    ? `${point.northing}, ${point.easting}`
    : `${point.northing}, ${point.easting}, ${point.elevation}`;
}

function measure(value: { value: number; unit: string; meters: number } | null | undefined): string {
  return value ? `${value.value} ${value.unit} (${value.meters} m)` : '—';
}

function engineeringRows(record: LandXmlSourceRecord, rootLinearUnit: string | undefined): Array<readonly [string, string]> {
  if (record.kind === 'pipe') return [
    ['cross-section', record.pipe.part.kind], ['diameter', measure(record.pipe.part.diameter)], ['span', measure(record.pipe.part.span)], ['width', measure(record.pipe.part.width)], ['height', measure(record.pipe.part.height)], ['thickness', measure(record.pipe.part.thickness)], ['material', record.pipe.part.material ?? '—'], ['length', measure(record.pipe.length)], ['flow in', record.pipe.flow?.flowIn?.toString() ?? '—'], ['flow unit', record.pipe.flow?.unit ?? record.pipe.units.flowUnit ?? '—'], ['linear unit', record.pipe.units.linearUnit], ['route', record.pipe.geometry.kind],
  ];
  if (record.kind === 'pipe-structure') return [
    ['part', record.structure.part.kind], ['diameter', measure(record.structure.part.diameter)], ['length', measure(record.structure.part.length)], ['width', measure(record.structure.part.width)], ['thickness', measure(record.structure.part.thickness)], ['material', record.structure.part.material ?? '—'], ['rim elevation', measure(record.structure.rimElevation)], ['sump elevation', measure(record.structure.sumpElevation)], ['inverts', record.structure.inverts.map((invert) => `${invert.flowDirection}: ${measure(invert.elevation)}`).join(', ') || '—'], ['flow losses', record.structure.flow ? `${record.structure.flow.lossIn ?? '—'} / ${record.structure.flow.lossOut ?? '—'} ${record.structure.flow.unit ?? ''}`.trim() : '—'], ['linear unit', record.structure.units.linearUnit],
  ];
  if (record.kind === 'pipe-network') return [
    ['network type', record.network.pipeNetworkType], ['structure units', record.network.structureUnits?.linearUnit ?? '—'], ['pipe units', record.network.pipeUnits?.linearUnit ?? '—'], ['structures', String(record.network.structures.length)], ['pipes', String(record.network.pipes.length)],
  ];
  if (record.kind === 'pipe-network-collection') return [['collection source', record.collection.sourceId], ['root linear unit', rootLinearUnit ?? '—']];
  return [];
}

/** Inspect retained LandXML source records without pretending they are IFC entities. */
export function LandXmlSourceInspector({ models, selected, onSelect }: LandXmlSourceInspectorProps) {
  const { t } = useTranslation();
  const [navigationPage, setNavigationPage] = useState(0);
  const [alignmentProbe, setAlignmentProbe] = useState<LandXmlAlignmentProbeResult | null>(null);
  const [alignmentInspection, setAlignmentInspection] = useState<LandXmlAlignmentInspectionResult | null>(null);
  const [probeMode, setProbeMode] = useState<'distance' | 'station'>('distance');
  const [distanceInput, setDistanceInput] = useState('0');
  const [stationInput, setStationInput] = useState('');
  const [offsetInput, setOffsetInput] = useState('0');
  const [probeError, setProbeError] = useState<string | null>(null);
  const record = useMemo(
    () => findLandXmlModelSourceRecord(models, selected),
    [models, selected],
  );

  useEffect(() => setNavigationPage(0), [selected.modelId, selected.sourceId]);

  useEffect(() => {
    const model = models.get(selected.modelId);
    const document = model?.landXmlDocument;
    const selectedAlignment = document?.alignments?.find((alignment) => alignment.sourceId === selected.sourceId)
      ?? document?.alignments?.find((alignment) => alignment.segments.some((segment) => segment.sourceId === selected.sourceId)
        || alignment.unsupportedTransitions.some((transition) => transition.sourceId === selected.sourceId));
    if (!selectedAlignment || !model?.sourceFile) {
      setAlignmentProbe(null); setAlignmentInspection(null); return;
    }
    let active = true;
    const controller = new AbortController();
    const distance = Number(distanceInput);
    const station = Number(stationInput);
    const offset = Number(offsetInput);
    const validInput = Number.isFinite(offset) && (probeMode === 'distance' ? Number.isFinite(distance) : Number.isFinite(station));
    if (!validInput) {
      setAlignmentProbe(null); setAlignmentInspection(null); setProbeError('Enter finite numeric probe values.');
      return () => { active = false; };
    }
    void model.sourceFile.arrayBuffer().then((buffer) => probeLandXmlAlignmentInWorker(buffer, {
      alignmentSourceId: selectedAlignment.sourceId,
      mode: probeMode,
      value: probeMode === 'distance' ? distance : station,
      offsetRight: offset,
    }, controller.signal)).then(({ probes, inspection }) => {
      const probe = probes[0];
      if (!probe) throw new Error('The displayed station is in a station-equation gap.');
      if (active) { setAlignmentProbe(probe); setAlignmentInspection(inspection); setProbeError(probes.length > 1 ? `Station resolves to ${probes.length} physical distances; showing the first.` : null); }
    }).catch((error: unknown) => {
      console.error('[LandXmlSourceInspector] alignment probe failed:', error);
      if (active) { setAlignmentProbe(null); setAlignmentInspection(null); setProbeError(error instanceof Error ? error.message : 'LandXML alignment probe failed.'); }
    });
    return () => { active = false; controller.abort(); };
  }, [models, selected.modelId, selected.sourceId, probeMode, distanceInput, stationInput, offsetInput]);

  if (!record) return null;
  if (record.kind === 'alignment' || record.kind === 'alignment-segment' || record.kind === 'unsupported-transition') {
    const alignment = record.alignment;
    const pages = Math.max(1, Math.ceil(alignmentNavigationCount(alignment) / NAVIGATION_PAGE_SIZE));
    const page = Math.min(navigationPage, pages - 1);
    const firstItem = page * NAVIGATION_PAGE_SIZE;
    const items = Array.from(
      { length: Math.min(NAVIGATION_PAGE_SIZE, alignmentNavigationCount(alignment) - firstItem) },
      (_, index) => alignmentNavigationAt(alignment, firstItem + index),
    );
    return (
      <div className="h-full overflow-auto border-l-2 border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black" data-landxml-source-inspector>
        <div className="space-y-2 border-b-2 border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-black">
          <p className="text-xs font-bold uppercase tracking-wide text-zinc-500">LandXML Alignment</p>
          <h3 className="truncate text-sm font-bold uppercase tracking-tight text-zinc-900 dark:text-zinc-100">{recordName(record, t)}</h3>
          <p className="break-all font-mono text-xs text-zinc-500">{recordPath(record)}</p>
        </div>
        <div className="divide-y divide-zinc-100 py-2 dark:divide-zinc-900">
          {items.map((item) => <button key={item.sourceId} type="button" className="block w-full px-4 py-2 text-left text-xs text-zinc-700 dark:text-zinc-300" onClick={() => onSelect({ modelId: selected.modelId, sourceId: item.sourceId })}>{item.label}</button>)}
        </div>
        {pages > 1 && <div className="flex items-center justify-between border-t border-zinc-200 px-4 py-2 text-xs dark:border-zinc-800"><button type="button" disabled={page === 0} onClick={() => setNavigationPage(page - 1)}>Previous</button><span>{page + 1} / {pages}</span><button type="button" disabled={page + 1 >= pages} onClick={() => setNavigationPage(page + 1)}>Next</button></div>}
        <div className="space-y-2 p-4 text-xs text-zinc-700 dark:text-zinc-300">
          <p>Length: {alignment.length}</p><p>Start station: {alignment.staStart}</p><p>Segments: {alignment.segments.length}</p>
          <label className="block">Probe by <select aria-label="Probe mode" value={probeMode} onChange={(event) => setProbeMode(event.target.value === 'station' ? 'station' : 'distance')}><option value="distance">geometric distance</option><option value="station">displayed station</option></select></label>
          {probeMode === 'distance' ? <label className="block">Distance <input aria-label="Geometric distance" type="number" value={distanceInput} onChange={(event) => setDistanceInput(event.target.value)} /></label> : <label className="block">Station <input aria-label="Displayed station" type="number" value={stationInput} onChange={(event) => setStationInput(event.target.value)} /></label>}
          <label className="block">Right offset <input aria-label="Right offset" type="number" value={offsetInput} onChange={(event) => setOffsetInput(event.target.value)} /></label>
          {probeError && <p role="alert" className="text-red-700 dark:text-red-300">Probe unavailable: {probeError}</p>}
          {alignmentProbe && <><p>Probe: {alignmentProbe.northing}, {alignmentProbe.easting}</p><p>Displayed station: {alignmentProbe.displayedBack} / {alignmentProbe.displayedAhead}</p><p>Probe span: {alignmentProbe.segmentSourceId}</p></>}
          {alignmentInspection && <><p>Authored CantStation bracket: {alignmentInspection.previousCantStation ? `${alignmentInspection.previousCantStation.station} (applied ${alignmentInspection.previousCantStation.appliedCant})` : 'none'} / {alignmentInspection.nextCantStation ? `${alignmentInspection.nextCantStation.station} (applied ${alignmentInspection.nextCantStation.appliedCant})` : 'none'}</p><p>Authored Superelevation: {alignmentInspection.superelevations.map((value) => `${value.staStart ?? 'open'}–${value.staEnd ?? 'open'}: ${value.events.map((event) => `${event.kind}${event.value === null ? '' : `=${event.value}`}`).join(', ')}`).join('; ') || 'none'}</p></>}
        </div>
      </div>
    );
  }
  const document = models.get(selected.modelId)?.landXmlDocument;
  const terrain = terrainRecord(record);
  if (record.kind === 'pipe' || record.kind === 'pipe-structure' || record.kind === 'pipe-feature' || record.kind === 'pipe-network' || record.kind === 'pipe-network-collection') {
    const properties = record.kind === 'pipe'
      ? record.pipe.properties
      : record.kind === 'pipe-structure' ? record.structure.properties
        : record.kind === 'pipe-feature' ? record.feature.properties
          : record.kind === 'pipe-network' ? record.network.properties : record.collection.properties;
    return <div className="h-full overflow-auto border-l-2 border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black" data-landxml-source-inspector>
      <div className="space-y-2 border-b-2 border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-black">
        <p className="text-xs font-bold uppercase tracking-wide text-zinc-500">{t('properties.landXmlSource.heading')}</p>
        <h3 className="truncate text-sm font-bold uppercase tracking-tight text-zinc-900 dark:text-zinc-100">{recordName(record, t)}</h3>
        <p className="break-all font-mono text-xs text-zinc-500">{recordPath(record)}</p>
      </div>
      <div className="space-y-2 p-4 text-xs text-zinc-700 dark:text-zinc-300">
        <p><span className="font-semibold">{t('properties.landXmlSource.kind')}:</span> {record.kind}</p>
        {engineeringRows(record, document?.pipeNetworks?.rootUnits?.linearUnit).map(([name, value]) => <p key={name}><span className="font-semibold">{name}:</span> {value}</p>)}
      </div>
      <SourceProperties title={t('properties.landXmlSource.properties')} rows={surfacePropertyRows(properties)} empty={t('properties.landXmlSource.noProperties')} />
    </div>;
  }
  if (!terrain && !planRecord(record)) {
    const count = semanticNavigationCount(record);
    const pages = Math.max(1, Math.ceil(count / NAVIGATION_PAGE_SIZE));
    const page = Math.min(navigationPage, pages - 1);
    const firstItem = page * NAVIGATION_PAGE_SIZE;
    const navigation = Array.from(
      { length: Math.min(NAVIGATION_PAGE_SIZE, count - firstItem) },
      (_, index) => semanticNavigationAt(record, firstItem + index),
    );
    const rows = semanticDetailRows(record);
    return <div className="h-full overflow-auto border-l-2 border-zinc-200 bg-white p-4 text-xs dark:border-zinc-800 dark:bg-black" data-landxml-source-inspector>
      <p className="text-xs font-bold uppercase tracking-wide text-zinc-500">{t('properties.landXmlSource.heading')}</p>
      <h3 className="mt-2 truncate text-sm font-bold uppercase tracking-tight text-zinc-900 dark:text-zinc-100">{recordName(record, t)}</h3>
      <p className="mt-1 break-all font-mono text-xs text-zinc-500">{recordPath(record)}</p>
      <p className="mt-3"><span className="font-semibold">{t('properties.landXmlSource.kind')}:</span> {record.kind}</p>
      {navigation.length > 0 && <div className="mt-3 border-y border-zinc-200 dark:border-zinc-800">
        <p className="pt-3 text-xs font-bold uppercase tracking-wide text-zinc-500">{t('properties.landXmlSource.navigation')}</p>
        <div className="divide-y divide-zinc-100 py-2 dark:divide-zinc-900">
          {navigation.map((item, index) => <button key={`${item.label}:${index}`} type="button" disabled={!item.sourceId}
            className="block w-full px-2 py-2 text-left text-xs text-zinc-700 disabled:text-zinc-500 dark:text-zinc-300"
            onClick={() => { if (item.sourceId) onSelect({ modelId: selected.modelId, sourceId: item.sourceId }); }}>
            {item.label}
          </button>)}
        </div>
        {pages > 1 && <div className="flex items-center justify-between border-t border-zinc-200 py-2 text-xs dark:border-zinc-800">
          <button type="button" disabled={page === 0} onClick={() => setNavigationPage(page - 1)}>{t('properties.landXmlSource.previous')}</button>
          <span>{t('properties.landXmlSource.page', { current: page + 1, total: pages })}</span>
          <button type="button" disabled={page + 1 >= pages} onClick={() => setNavigationPage(page + 1)}>{t('properties.landXmlSource.next')}</button>
        </div>}
      </div>}
      <dl className="mt-3 space-y-2">
        {rows.map((row, index) => <div key={`${row.label}:${row.value}:${index}`} className="flex gap-2">
          <dt className="shrink-0 font-semibold text-zinc-500">{row.label}</dt>
          <dd className="min-w-0 break-all">{row.sourceId ? <button type="button" className="text-left text-primary underline" onClick={() => { if (row.sourceId) onSelect({ modelId: selected.modelId, sourceId: row.sourceId }); }}>{row.value}</button> : row.value}</dd>
        </div>)}
      </dl>
    </div>;
  }
  const sourceCount = terrain ? document?.rendering.surfaceCounts.find((counts) => counts.surfaceSourceId === record.surface.sourceId) : undefined;
  const plannedNavigation = planNavigation(record, navigationPage * NAVIGATION_PAGE_SIZE, t);
  const itemCount = terrain ? navigationCount(record.surface) : plannedNavigation.total;
  const pages = itemCount === 0 ? 0 : Math.ceil(itemCount / NAVIGATION_PAGE_SIZE);
  const page = pages === 0 ? 0 : Math.min(navigationPage, pages - 1);
  const navigation = terrain ? Array.from(
    { length: Math.min(NAVIGATION_PAGE_SIZE, itemCount - page * NAVIGATION_PAGE_SIZE) },
    (_, index) => navigationAt(record.surface, page * NAVIGATION_PAGE_SIZE + index, t),
  ) : planNavigation(record, page * NAVIGATION_PAGE_SIZE, t).items;
  const probe = record.kind === 'parcel'
    ? document?.plan?.parcelProbesBySource?.get(record.parcel.sourceId)
      ?? document?.plan?.parcelProbes.find((candidate) => candidate.sourceId === record.parcel.sourceId)
    : undefined;
  const resolvedMonument = record.kind === 'monument'
    ? (document?.plan?.resolvedMonumentsBySource?.get(record.monument.sourceId)
      ?? document?.plan?.resolvedMonuments.find((candidate) => candidate.sourceId === record.monument.sourceId))?.point
    : undefined;
  const resolvedGeometry = record.kind === 'plan-geometry'
    ? document?.plan?.resolvedGeometryBySource?.get(record.geometry.sourceId)
      ?? document?.plan?.resolvedGeometry.find((candidate) => candidate.sourceId === record.geometry.sourceId)
    : undefined;
  const properties = surfacePropertyRows(terrain ? record.surface.properties : planProperties(record));
  const definitionProperties = surfacePropertyRows(terrain ? record.surface.definitionProperties : {});
  return (
    <div className="h-full overflow-auto border-l-2 border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black" data-landxml-source-inspector>
      <div className="space-y-2 border-b-2 border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-black">
        <p className="text-xs font-bold uppercase tracking-wide text-zinc-500">{t('properties.landXmlSource.heading')}</p>
        <h3 className="truncate text-sm font-bold uppercase tracking-tight text-zinc-900 dark:text-zinc-100">{recordName(record, t)}</h3>
        <p className="break-all font-mono text-xs text-zinc-500">{recordPath(record)}</p>
      </div>
      {record.kind === 'surface' && (
        <p className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {t('properties.landXmlSource.pickLimitation')}
        </p>
      )}
      {itemCount > 0 && <div className="border-b border-zinc-200 dark:border-zinc-800">
        <p className="px-4 pt-3 text-xs font-bold uppercase tracking-wide text-zinc-500">{t('properties.landXmlSource.navigation')}</p>
        <div className="divide-y divide-zinc-100 py-2 dark:divide-zinc-900">
          {navigation.map((item) => (
            <button
              key={item.sourceId}
              type="button"
              className={`block w-full px-4 py-2 text-left text-xs ${item.sourceId === selected.sourceId ? 'bg-primary/10 text-primary' : 'text-zinc-700 dark:text-zinc-300'}`}
              onClick={() => onSelect({ modelId: selected.modelId, sourceId: item.sourceId })}
            >
              {item.label}
            </button>
          ))}
        </div>
        {pages > 1 && (
          <div className="flex items-center justify-between border-t border-zinc-200 px-4 py-2 text-xs dark:border-zinc-800">
            <button type="button" disabled={page === 0} onClick={() => setNavigationPage(page - 1)}>{t('properties.landXmlSource.previous')}</button>
            <span>{t('properties.landXmlSource.page', { current: page + 1, total: pages })}</span>
            <button type="button" disabled={page + 1 >= pages} onClick={() => setNavigationPage(page + 1)}>{t('properties.landXmlSource.next')}</button>
          </div>
        )}
      </div>}
      <div className="space-y-2 p-4 text-xs text-zinc-700 dark:text-zinc-300">
        <p><span className="font-semibold">{t('properties.landXmlSource.kind')}:</span> {record.kind}</p>
        {terrain && <p><span className="font-semibold">{t('properties.landXmlSource.renderState')}:</span> {record.surface.renderState}</p>}
        {document && <p><span className="font-semibold">{t('properties.landXmlSource.capabilities')}:</span> {JSON.stringify(document.capabilities)}</p>}
        {document?.warnings.map((warning, index) => <p key={`${warning}-${index}`} role="alert" className="text-amber-800 dark:text-amber-200">Source refusal: {warning}</p>)}
        {sourceCount && <p><span className="font-semibold">{t('properties.landXmlSource.counts')}:</span> {t('properties.landXmlSource.countsValue', { ...sourceCount })}</p>}
        {record.kind === 'face' && <p><span className="font-semibold">{t('properties.landXmlSource.facePoints')}:</span> {record.pointIds.join(', ')}</p>}
        {record.kind === 'point' && <p><span className="font-semibold">{t('properties.landXmlSource.pointCoordinates')}:</span> {record.point.northing}, {record.point.easting}, {record.point.elevation}</p>}
        {record.kind === 'source-data-point' && <p><span className="font-semibold">{t('properties.landXmlSource.pointCoordinates')}:</span> {record.point.coordinates.join(', ')}</p>}
        {(record.kind === 'boundary' || record.kind === 'breakline' || record.kind === 'contour') && (
          <p><span className="font-semibold">{t('properties.landXmlSource.points')}:</span> {record.line.points.length}</p>
        )}
        {record.kind === 'cogo-point' && record.point.point && <p><span className="font-semibold">{t('properties.landXmlSource.pointCoordinates')}:</span> {pointText(record.point.point)}</p>}
        {record.kind === 'monument' && resolvedMonument && <p>{t('properties.landXmlSource.resolvedMonument', { coordinates: pointText(resolvedMonument) })}</p>}
        {record.kind === 'monument' && !resolvedMonument && <p>{t('properties.landXmlSource.unresolvedMonument')}</p>}
        {record.kind === 'parcel' && <>
          {record.parcel.title && <p>{t('properties.landXmlSource.parcelTitle', { title: record.parcel.title })}</p>}
          <p>{t('properties.landXmlSource.parcelStatus', { status: probe?.state.kind ?? 'preserved_only' })}</p>
          {probe?.state.kind === 'preserved_only' && <p>{t('properties.landXmlSource.parcelReason', { reason: probe.state.reason })}</p>}
          {probe?.state.kind === 'analytic' && <p>{t('properties.landXmlSource.parcelProbe', {
            perimeter: probe.perimeterInDeclaredLinearUnits ?? '',
            computedArea: probe.areaInDeclaredSquareUnits ?? '',
            declaredAreaUnit: record.parcel.declaredAreaUnit ?? document?.plan?.areaUnit ?? 'coordinate²',
            areaSquareMeters: probe.areaInSquareMeters ?? '',
          })}</p>}
        </>}
        {record.kind === 'plan-geometry' && <>
          <p>{t('properties.landXmlSource.geometryEndpoints', {
            start: resolvedGeometry?.start ? pointText(resolvedGeometry.start) : t('properties.landXmlSource.unresolved'),
            end: resolvedGeometry?.end ? pointText(resolvedGeometry.end) : t('properties.landXmlSource.unresolved'),
          })}</p>
          {record.geometry.kind === 'curve' && <p>{t('properties.landXmlSource.curveDetail', {
            rotation: record.geometry.rotation ?? t('properties.landXmlSource.unoriented'),
            radius: record.geometry.radius ?? t('properties.landXmlSource.derived'),
            center: resolvedGeometry?.center ? pointText(resolvedGeometry.center) : t('properties.landXmlSource.unresolved'),
            pi: resolvedGeometry?.pi ? pointText(resolvedGeometry.pi) : t('properties.landXmlSource.none'),
          })}</p>}
        </>}
      </div>
      <SourceProperties title={t(terrain ? 'properties.landXmlSource.surfaceProperties' : 'properties.landXmlSource.properties')} rows={properties} empty={t('properties.landXmlSource.noProperties')} />
      <SourceProperties title={t('properties.landXmlSource.definitionProperties')} rows={definitionProperties} empty={t('properties.landXmlSource.noProperties')} />
    </div>
  );
}

function SourceProperties({ title, rows, empty }: { title: string; rows: Array<readonly [string, string]>; empty: string }) {
  return <div className="border-t border-zinc-200 p-4 text-xs dark:border-zinc-800">
    <p className="mb-2 font-bold uppercase tracking-wide text-zinc-500">{title}</p>
    {rows.length === 0 ? <p className="text-zinc-500">{empty}</p> : (
      <dl className="space-y-1">
        {rows.map(([name, value]) => <div key={name} className="flex gap-2"><dt className="font-mono text-zinc-500">{name}</dt><dd className="break-all">{value}</dd></div>)}
      </dl>
    )}
  </div>;
}
