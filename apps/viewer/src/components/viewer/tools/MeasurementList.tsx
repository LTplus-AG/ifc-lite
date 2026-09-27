/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The LIST tab of the Measurements panel (#5502): every finished
 * measurement of every kind, each in its own list, plus the gesture in
 * progress. Distances, polylines, angles and radii are kept in separate
 * lists rather than merged: an open length, a closed perimeter, an angle
 * and a fitted radius are different KINDS of number from a point-to-point
 * distance, so blending them into one "Total" would add numbers that don't
 * share a basis.
 */

import { Ruler, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useViewerStore, type Measurement } from '@/store';
import { useTranslation } from '@/i18n/useTranslation';
import { StaleMeasurementBadge } from '../reposition/StaleMeasurementBadge';
import { formatDistance } from './formatDistance';
import { distanceComponents, formatAxisDeltas, formatHorizontalVertical } from './measure-modes/components';
import { inclination, formatInclination } from './measure-modes/inclination';
import { polylineBasisLabelKey } from './measure-modes/polyline';
import { projectedEnh, EnhLine } from './measure-modes/geo-readout';
import { useAnchorGeoreference, type AnchorGeoreference } from '@/lib/geo/useAnchorGeoreference';
import { ANGLE_REQUIRED_PICKS, formatAngleMeasurement, formatRadiusPoints } from './measure-modes/readouts';

const ROW = 'rounded bg-muted/50 px-2 py-1 text-xs';
const ROW_LIVE = 'flex items-center justify-between gap-2 rounded bg-overlay-accent-soft px-2 py-1 text-xs';
// `size="icon-sm"` (32px) overridden to h-5 w-5 (20px): 2px a side of
// hit-slop reaches the WCAG 2.2 2.5.8 24px minimum (#5826). Each of these
// buttons is the last (or only) item in its `justify-between` row, so
// there is no neighbour to overlap.
const HIT_SLOP = 'relative after:absolute after:-inset-0.5 after:content-[""]';
const DELETE = `h-5 w-5 shrink-0 hover:bg-destructive/20 ${HIT_SLOP}`;

export function MeasurementList() {
  const { t } = useTranslation();
  const measurements = useViewerStore((s) => s.measurements);
  const activePolyline = useViewerStore((s) => s.activePolyline);
  const polylineMeasurements = useViewerStore((s) => s.polylineMeasurements);
  const angleMeasurements = useViewerStore((s) => s.angleMeasurements);
  const activeAngle = useViewerStore((s) => s.activeAngle);
  const radiusMeasurements = useViewerStore((s) => s.radiusMeasurements);
  const activeRadius = useViewerStore((s) => s.activeRadius);
  const activeTool = useViewerStore((s) => s.activeTool);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const cancelPolyline = useViewerStore((s) => s.cancelPolyline);
  const cancelRadius = useViewerStore((s) => s.cancelRadius);
  const deleteMeasurement = useViewerStore((s) => s.deleteMeasurement);
  const deletePolylineMeasurement = useViewerStore((s) => s.deletePolylineMeasurement);
  const deleteAngleMeasurement = useViewerStore((s) => s.deleteAngleMeasurement);
  const deleteRadiusMeasurement = useViewerStore((s) => s.deleteRadiusMeasurement);
  const unitDisplayOverrides = useViewerStore((s) => s.unitDisplayOverrides);
  const geoReadoutEnabled = useViewerStore((s) => s.geoReadoutEnabled);
  const stale = useViewerStore((s) => s.placementStaleMeasurements);
  const anchor = useAnchorGeoreference();
  const geoAnchor = geoReadoutEnabled ? anchor : null;

  const totalDistance = measurements.reduce((sum, m) => sum + (stale.has(m.id) ? 0 : m.distance), 0);
  const totalItemCount =
    measurements.length + polylineMeasurements.length + angleMeasurements.length + radiusMeasurements.length;

  if (totalItemCount === 0 && !activePolyline && !activeAngle && !activeRadius) {
    return (
      <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-xs text-muted-foreground">
        <span>{t('measure.list.empty')}</span>
        {activeTool !== 'measure' && (
          <Button variant="outline" size="sm" onClick={() => setActiveTool('measure')}>
            <Ruler className="mr-1.5 h-3.5 w-3.5" />
            {t('measure.panel.startMeasuring')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1 px-3 py-2">
      {measurements.map((m, i) => (
        <MeasurementItem
          key={m.id}
          measurement={m}
          index={i}
          onDelete={deleteMeasurement}
          deleteLabel={t('measure.list.deleteDistance', { index: i + 1 })}
          geoAnchor={geoAnchor}
          unitDisplayOverrides={unitDisplayOverrides}
        />
      ))}
      {measurements.length > 1 && (
        <div className="mt-1 flex items-center justify-between border-t pt-1 text-xs font-medium">
          <span>{t('measure.list.totalCurrent')}</span>
          <span className="tabular-nums">{formatDistance(totalDistance, unitDisplayOverrides)}</span>
        </div>
      )}

      {activePolyline && (
        <div className={ROW_LIVE}>
          <span className="tabular-nums">{t('measure.polyline.inProgress', { count: activePolyline.points.length })}</span>
          <IconButton label={t('measure.cancelEsc')} variant="ghost" size="icon-sm" className={`h-5 w-5 ${HIT_SLOP}`} onClick={cancelPolyline}>
            <X className="h-3 w-3" />
          </IconButton>
        </div>
      )}
      {polylineMeasurements.map((pl, i) => (
        <div key={pl.id} className={ROW}>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">
              {t('measure.polyline.indexLabel', { index: i + 1 })} · {t(polylineBasisLabelKey(pl.closed))}
              <StaleMeasurementBadge id={pl.id} />
            </span>
            <span className="ml-auto font-medium tabular-nums">{formatDistance(pl.length, unitDisplayOverrides)}</span>
            <IconButton label={t('measure.list.deletePolyline', { index: i + 1 })} variant="ghost" size="icon-sm" className={DELETE} onClick={() => deletePolylineMeasurement(pl.id)}>
              <X className="h-3 w-3" />
            </IconButton>
          </div>
        </div>
      ))}

      {angleMeasurements.map((a, i) => (
        <div key={a.id} className={ROW}>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">
              {t('measure.angle.indexLabel', { index: i + 1 })}
              <StaleMeasurementBadge id={a.id} />
            </span>
            {/* Derived on render, never stored (see measure-modes/readouts). */}
            <span className="ml-auto font-medium tabular-nums">{formatAngleMeasurement(a)}</span>
            <IconButton label={t('measure.list.deleteAngle', { index: i + 1 })} variant="ghost" size="icon-sm" className={DELETE} onClick={() => deleteAngleMeasurement(a.id)}>
              <X className="h-3 w-3" />
            </IconButton>
          </div>
        </div>
      ))}
      {activeAngle && (
        <div className={ROW_LIVE}>
          <span className="tabular-nums">
            {t('measure.angle.inProgress', {
              picks: activeAngle.picks.length,
              required: ANGLE_REQUIRED_PICKS[activeAngle.kind],
            })}
            {activeAngle.kind === 'points' && activeAngle.picks.length === 1 ? t('measure.angle.apexSetSuffix') : ''}
            {activeAngle.kind === 'edges' && activeAngle.picks.length === 2 ? t('measure.angle.firstEdgeSetSuffix') : ''}
          </span>
        </div>
      )}

      {radiusMeasurements.map((r, i) => (
        <div key={r.id} className={ROW}>
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-muted-foreground">
              {t('measure.radius.indexLabel', { index: i + 1 })}
              <StaleMeasurementBadge id={r.id} />
            </span>
            <span className="ml-auto text-right font-medium tabular-nums">{formatRadiusPoints(r.points, unitDisplayOverrides)}</span>
            <IconButton label={t('measure.list.deleteRadius', { index: i + 1 })} variant="ghost" size="icon-sm" className={DELETE} onClick={() => deleteRadiusMeasurement(r.id)}>
              <X className="h-3 w-3" />
            </IconButton>
          </div>
        </div>
      ))}
      {activeRadius && (
        <div className={ROW_LIVE}>
          {/* Live: the same fit the finished list uses, re-derived on every
              added point — reaches "fitted"/"refused" as soon as the picks
              clear the module's gate, no finish step required to SEE it. */}
          <span className="tabular-nums">
            {t('measure.radius.inProgress', { count: activeRadius.points.length })} · {formatRadiusPoints(activeRadius.points, unitDisplayOverrides)}
          </span>
          <IconButton label={t('measure.cancelEsc')} variant="ghost" size="icon-sm" className={`h-5 w-5 shrink-0 ${HIT_SLOP}`} onClick={cancelRadius}>
            <X className="h-3 w-3" />
          </IconButton>
        </div>
      )}
    </div>
  );
}

interface MeasurementItemProps {
  measurement: Measurement;
  index: number;
  onDelete: (id: string) => void;
  deleteLabel: string;
  /** When set, show real-world E/N/H for the measurement's two endpoints. */
  geoAnchor: AnchorGeoreference | null;
  /** The user's per-unit-type display override (#1573). */
  unitDisplayOverrides: Record<string, string>;
}

function MeasurementItem({ measurement, index, onDelete, deleteLabel, geoAnchor, unitDisplayOverrides }: MeasurementItemProps) {
  // Pure display: derived from the stored endpoints, nothing is persisted.
  const components = distanceComponents(measurement.start, measurement.end);
  return (
    <div className={ROW}>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">
          #{index + 1}
          <StaleMeasurementBadge id={measurement.id} />
        </span>
        <span className="ml-auto font-medium tabular-nums">{formatDistance(measurement.distance, unitDisplayOverrides)}</span>
        <IconButton label={deleteLabel} variant="ghost" size="icon-sm" className={DELETE} onClick={() => onDelete(measurement.id)}>
          <X className="h-3 w-3" />
        </IconButton>
      </div>
      <div className="overflow-x-auto whitespace-nowrap font-mono text-2xs leading-tight text-muted-foreground">
        <div>{formatAxisDeltas(components, unitDisplayOverrides)}</div>
        <div>{formatHorizontalVertical(components, unitDisplayOverrides)}</div>
        {/* Inclination, derived from the same two endpoints (#2199 §4). */}
        <div>{formatInclination(inclination(components))}</div>
      </div>
      {geoAnchor && (
        <div className="mt-0.5 overflow-x-auto">
          <EnhLine label="A" enh={projectedEnh(measurement.start, geoAnchor)} />
          <EnhLine label="B" enh={projectedEnh(measurement.end, geoAnchor)} />
        </div>
      )}
    </div>
  );
}
