/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import { useTranslation } from '@/i18n';
import {
  findLandXmlModelSourceRecord,
  type LandXmlSourceModel,
  type LandXmlSourceRecord,
  type LandXmlSourceRef,
} from '@/hooks/ingest/landXmlSemantics';

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
    default: return record.line.name ?? record.line.sourceId;
  }
}

function recordPath(record: LandXmlSourceRecord): string {
  switch (record.kind) {
    case 'surface': return record.surface.sourcePath;
    case 'point': return `${record.surface.sourcePath}/Definition/Pnts/P[@id="${record.point.id}"]`;
    case 'face': return `${record.surface.sourcePath}/Definition/Faces/F`;
    case 'source-data-point': return record.point.sourcePath;
    default: return record.line.sourcePath;
  }
}

function navigationRecords(surface: LandXmlSourceRecord['surface']): Array<{ label: string; sourceId: string }> {
  return [
    { label: `Surface: ${surface.name}`, sourceId: surface.sourceId },
    ...surface.points.map((point) => ({ label: `Point: ${point.id}`, sourceId: point.sourceId })),
    ...surface.sourceDataPoints.map((point) => ({ label: `Source point ${point.ordinal}`, sourceId: point.sourceId })),
    ...surface.faceSourceIds.map((sourceId, index) => ({ label: `Face ${index + 1}`, sourceId })),
    ...surface.boundaries.map((line) => ({ label: `Boundary: ${line.name ?? line.ordinal}`, sourceId: line.sourceId })),
    ...surface.breaklines.map((line) => ({ label: `Breakline: ${line.name ?? line.ordinal}`, sourceId: line.sourceId })),
    ...surface.contours.map((line) => ({ label: `Contour: ${line.name ?? line.ordinal}`, sourceId: line.sourceId })),
  ];
}

/** Inspect retained LandXML source records without pretending they are IFC entities. */
export function LandXmlSourceInspector({ models, selected, onSelect }: LandXmlSourceInspectorProps) {
  const { t } = useTranslation();
  const record = useMemo(
    () => findLandXmlModelSourceRecord(models, selected),
    [models, selected],
  );

  if (!record) return null;
  const navigation = navigationRecords(record.surface);
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
      </div>
      <div className="space-y-2 p-4 text-xs text-zinc-700 dark:text-zinc-300">
        <p><span className="font-semibold">{t('properties.landXmlSource.kind')}:</span> {record.kind}</p>
        {record.kind === 'face' && <p><span className="font-semibold">{t('properties.landXmlSource.facePoints')}:</span> {record.pointIds.join(', ')}</p>}
        {record.kind === 'point' && <p><span className="font-semibold">{t('properties.landXmlSource.pointCoordinates')}:</span> {record.point.northing}, {record.point.easting}, {record.point.elevation}</p>}
        {record.kind === 'source-data-point' && <p><span className="font-semibold">{t('properties.landXmlSource.pointCoordinates')}:</span> {record.point.coordinates.join(', ')}</p>}
        {record.kind !== 'surface' && record.kind !== 'face' && record.kind !== 'point' && record.kind !== 'source-data-point' && (
          <p><span className="font-semibold">{t('properties.landXmlSource.points')}:</span> {record.line.points.length}</p>
        )}
      </div>
    </div>
  );
}
