/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@/i18n';
import {
  findLandXmlModelSourceRecord,
  type LandXmlSourceModel,
  type LandXmlSourceRecord,
  type LandXmlSourceRef,
} from '@/hooks/ingest/landXmlSemantics';
import {
  inspectLandXmlAlignmentAtDistance,
  probeLandXmlAlignmentAtDistance,
  type LandXmlAlignmentInspectionResult,
  type LandXmlAlignmentProbeResult,
} from '@/hooks/ingest/landXmlWasm';

interface LandXmlSourceInspectorProps {
  models: ReadonlyMap<string, LandXmlSourceModel>;
  selected: LandXmlSourceRef;
  onSelect(ref: LandXmlSourceRef): void;
}

function recordName(record: LandXmlSourceRecord): string {
  switch (record.kind) {
    case 'surface': return record.surface.name;
    case 'point': return record.point.id;
    case 'source-data-point': return `Source point ${record.point.ordinal}`;
    case 'face': return record.pointIds.join(', ');
    case 'alignment': return record.alignment.name;
    case 'alignment-segment': return `Segment ${record.segment.ordinal}`;
    default: return record.line.name ?? record.line.sourceId;
  }
}

function recordPath(record: LandXmlSourceRecord): string {
  switch (record.kind) {
    case 'surface': return record.surface.sourcePath;
    case 'point': return `${record.surface.sourcePath}/Definition/Pnts/P[@id="${record.point.id}"]`;
    case 'face': return `${record.surface.sourcePath}/Definition/Faces/F`;
    case 'source-data-point': return record.point.sourcePath;
    case 'alignment': return `LandXML/Alignments/Alignment[${record.alignment.ordinal}]`;
    case 'alignment-segment': return `LandXML/Alignments/Alignment[${record.alignment.ordinal}]/CoordGeom`;
    default: return record.line.sourcePath;
  }
}

const NAVIGATION_PAGE_SIZE = 100;

type NavigationItem = { label: string; sourceId: string };

function navigationCount(surface: LandXmlSourceRecord['surface']): number {
  return 1 + surface.points.length + surface.sourceDataPoints.length + surface.faceSourceIds.length
    + surface.boundaries.length + surface.breaklines.length + surface.contours.length;
}

/** Materialize one page only: survey surfaces may contain millions of points. */
function navigationAt(surface: LandXmlSourceRecord['surface'], itemIndex: number): NavigationItem {
  if (itemIndex === 0) return { label: `Surface: ${surface.name}`, sourceId: surface.sourceId };
  let index = itemIndex - 1;
  const point = surface.points[index];
  if (point) return { label: `Point: ${point.id}`, sourceId: point.sourceId };
  index -= surface.points.length;
  const sourcePoint = surface.sourceDataPoints[index];
  if (sourcePoint) return { label: `Source point ${sourcePoint.ordinal}`, sourceId: sourcePoint.sourceId };
  index -= surface.sourceDataPoints.length;
  const faceSourceId = surface.faceSourceIds[index];
  if (faceSourceId) return { label: `Face ${index + 1}`, sourceId: faceSourceId };
  index -= surface.faceSourceIds.length;
  const boundary = surface.boundaries[index];
  if (boundary) return { label: `Boundary: ${boundary.name ?? boundary.ordinal}`, sourceId: boundary.sourceId };
  index -= surface.boundaries.length;
  const breakline = surface.breaklines[index];
  if (breakline) return { label: `Breakline: ${breakline.name ?? breakline.ordinal}`, sourceId: breakline.sourceId };
  index -= surface.breaklines.length;
  const contour = surface.contours[index];
  if (contour) return { label: `Contour: ${contour.name ?? contour.ordinal}`, sourceId: contour.sourceId };
  throw new Error(`LandXML source navigation index ${itemIndex} is outside the retained surface records`);
}

function surfacePropertyRows(properties: Record<string, string>): Array<readonly [string, string]> {
  return Object.entries(properties).sort(([left], [right]) => left.localeCompare(right));
}

/** Inspect retained LandXML source records without pretending they are IFC entities. */
export function LandXmlSourceInspector({ models, selected, onSelect }: LandXmlSourceInspectorProps) {
  const { t } = useTranslation();
  const [navigationPage, setNavigationPage] = useState(0);
  const [alignmentProbe, setAlignmentProbe] = useState<LandXmlAlignmentProbeResult | null>(null);
  const [alignmentInspection, setAlignmentInspection] = useState<LandXmlAlignmentInspectionResult | null>(null);
  const record = useMemo(
    () => findLandXmlModelSourceRecord(models, selected),
    [models, selected],
  );

  useEffect(() => setNavigationPage(0), [selected.modelId, selected.sourceId]);

  useEffect(() => {
    const model = models.get(selected.modelId);
    const document = model?.landXmlDocument;
    const selectedAlignment = document?.alignments?.find((alignment) => alignment.sourceId === selected.sourceId)
      ?? document?.alignments?.find((alignment) => alignment.segments.some((segment) => segment.sourceId === selected.sourceId));
    if (!selectedAlignment || !model?.sourceFile) {
      setAlignmentProbe(null); setAlignmentInspection(null); return;
    }
    let active = true;
    void model.sourceFile.arrayBuffer().then(async (buffer) => {
      const [probe, inspection] = await Promise.all([
        probeLandXmlAlignmentAtDistance(buffer, selectedAlignment.sourceId, 0),
        inspectLandXmlAlignmentAtDistance(buffer, selectedAlignment.sourceId, 0),
      ]);
      if (active) { setAlignmentProbe(probe); setAlignmentInspection(inspection); }
    }).catch(() => { if (active) { setAlignmentProbe(null); setAlignmentInspection(null); } });
    return () => { active = false; };
  }, [models, selected.modelId, selected.sourceId]);

  if (!record) return null;
  if (record.kind === 'alignment' || record.kind === 'alignment-segment') {
    const alignment = record.alignment;
    const pages = Math.ceil((alignment.segments.length + 1) / NAVIGATION_PAGE_SIZE);
    const page = Math.min(navigationPage, pages - 1);
    const firstItem = page * NAVIGATION_PAGE_SIZE;
    const items = [
      { label: `Alignment: ${alignment.name}`, sourceId: alignment.sourceId },
      ...alignment.segments.map((segment) => ({ label: `Segment ${segment.ordinal}: ${segment.primitive.kind}`, sourceId: segment.sourceId })),
    ].slice(firstItem, firstItem + NAVIGATION_PAGE_SIZE);
    return (
      <div className="h-full overflow-auto border-l-2 border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black" data-landxml-source-inspector>
        <div className="space-y-2 border-b-2 border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-black">
          <p className="text-xs font-bold uppercase tracking-wide text-zinc-500">LandXML Alignment</p>
          <h3 className="truncate text-sm font-bold uppercase tracking-tight text-zinc-900 dark:text-zinc-100">{recordName(record)}</h3>
          <p className="break-all font-mono text-xs text-zinc-500">{recordPath(record)}</p>
        </div>
        <div className="divide-y divide-zinc-100 py-2 dark:divide-zinc-900">
          {items.map((item) => <button key={item.sourceId} type="button" className="block w-full px-4 py-2 text-left text-xs text-zinc-700 dark:text-zinc-300" onClick={() => onSelect({ modelId: selected.modelId, sourceId: item.sourceId })}>{item.label}</button>)}
        </div>
        {pages > 1 && <div className="flex items-center justify-between border-t border-zinc-200 px-4 py-2 text-xs dark:border-zinc-800"><button type="button" disabled={page === 0} onClick={() => setNavigationPage(page - 1)}>Previous</button><span>{page + 1} / {pages}</span><button type="button" disabled={page + 1 >= pages} onClick={() => setNavigationPage(page + 1)}>Next</button></div>}
        <div className="space-y-2 p-4 text-xs text-zinc-700 dark:text-zinc-300"><p>Length: {alignment.length}</p><p>Start station: {alignment.staStart}</p><p>Segments: {alignment.segments.length}</p>{alignmentProbe && <><p>Start probe: {alignmentProbe.northing}, {alignmentProbe.easting}</p><p>Displayed station: {alignmentProbe.displayedBack} / {alignmentProbe.displayedAhead}</p><p>Probe span: {alignmentProbe.segmentSourceId}</p></>}{alignmentInspection && <><p>Authored CantStation bracket: {alignmentInspection.previousCantStation ?? 'none'} / {alignmentInspection.nextCantStation ?? 'none'}</p><p>Authored Superelevation blocks: {alignmentInspection.superelevationCount}</p></>}</div>
      </div>
    );
  }
  const document = models.get(selected.modelId)?.landXmlDocument;
  const sourceCount = document?.rendering.surfaceCounts.find((counts) => counts.surfaceSourceId === record.surface.sourceId);
  const pages = Math.ceil(navigationCount(record.surface) / NAVIGATION_PAGE_SIZE);
  const page = Math.min(navigationPage, pages - 1);
  const firstItem = page * NAVIGATION_PAGE_SIZE;
  const navigation = Array.from(
    { length: Math.min(NAVIGATION_PAGE_SIZE, navigationCount(record.surface) - firstItem) },
    (_, index) => navigationAt(record.surface, firstItem + index),
  );
  const properties = surfacePropertyRows(record.surface.properties);
  const definitionProperties = surfacePropertyRows(record.surface.definitionProperties);
  return (
    <div className="h-full overflow-auto border-l-2 border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black" data-landxml-source-inspector>
      <div className="space-y-2 border-b-2 border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-black">
        <p className="text-xs font-bold uppercase tracking-wide text-zinc-500">{t('properties.landXmlSource.heading')}</p>
        <h3 className="truncate text-sm font-bold uppercase tracking-tight text-zinc-900 dark:text-zinc-100">{recordName(record)}</h3>
        <p className="break-all font-mono text-xs text-zinc-500">{recordPath(record)}</p>
      </div>
      {record.kind === 'surface' && (
        <p className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {t('properties.landXmlSource.pickLimitation')}
        </p>
      )}
      <div className="border-b border-zinc-200 dark:border-zinc-800">
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
      </div>
      <div className="space-y-2 p-4 text-xs text-zinc-700 dark:text-zinc-300">
        <p><span className="font-semibold">{t('properties.landXmlSource.kind')}:</span> {record.kind}</p>
        <p><span className="font-semibold">{t('properties.landXmlSource.renderState')}:</span> {record.surface.renderState}</p>
        {document && <p><span className="font-semibold">{t('properties.landXmlSource.capabilities')}:</span> {JSON.stringify(document.capabilities)}</p>}
        {sourceCount && <p><span className="font-semibold">{t('properties.landXmlSource.counts')}:</span> {t('properties.landXmlSource.countsValue', { ...sourceCount })}</p>}
        {record.kind === 'face' && <p><span className="font-semibold">{t('properties.landXmlSource.facePoints')}:</span> {record.pointIds.join(', ')}</p>}
        {record.kind === 'point' && <p><span className="font-semibold">{t('properties.landXmlSource.pointCoordinates')}:</span> {record.point.northing}, {record.point.easting}, {record.point.elevation}</p>}
        {record.kind === 'source-data-point' && <p><span className="font-semibold">{t('properties.landXmlSource.pointCoordinates')}:</span> {record.point.coordinates.join(', ')}</p>}
        {record.kind !== 'surface' && record.kind !== 'face' && record.kind !== 'point' && record.kind !== 'source-data-point' && (
          <p><span className="font-semibold">{t('properties.landXmlSource.points')}:</span> {record.line.points.length}</p>
        )}
      </div>
      <SourceProperties title={t('properties.landXmlSource.surfaceProperties')} rows={properties} empty={t('properties.landXmlSource.noProperties')} />
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
