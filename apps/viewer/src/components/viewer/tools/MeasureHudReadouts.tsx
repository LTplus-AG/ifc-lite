/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Measure tool's bottom-center HUD items (#5502): the one hint line
 * (`HudHint`, bare text, order 1 — nearest the bottom edge) and, above it,
 * the live real-world XYZ readout on the shared card surface (order 0),
 * shown only while Geo XYZ is on and the anchor model is georeferenced.
 * In Point mode (#8770) a compact Model XYZ line sits on top of both
 * (order -1), so the mode's answer is on screen without opening the panel.
 */

import { Crosshair, Globe } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n/useTranslation';
import { useAnchorGeoreference } from '@/lib/geo/useAnchorGeoreference';
import { useRenderFrameOffsets } from '@/hooks/useRenderFrameOffsets';
import { HudHint, HudItem, HudSurface } from '../../viewport-ui/hud';
import { measureHintKey } from './measure-modes/readouts';
import { projectedEnh, useProjectedLatLon } from './measure-modes/geo-readout';
import { formatCoordinateTriple, pointCoordinates } from './measure-modes/coordinates';
import { useMeasureLivePoint } from './measure-modes/useMeasureLivePoint';
import { StaleMeasurementBadge } from '../reposition/StaleMeasurementBadge';

export function MeasureHint() {
  const { t } = useTranslation();
  const key = useViewerStore((s) =>
    measureHintKey({
      measureMode: s.measureMode,
      angleKind: s.angleKind,
      activeAngle: s.activeAngle,
      activePolyline: s.activePolyline,
      activeRadius: s.activeRadius,
      activeMeasurement: s.activeMeasurement,
      measurePointLast: s.measurePointLast,
    }),
  );
  return (
    <HudItem region="bottom-center" order={1}>
      <HudHint>{t(key)}</HudHint>
    </HudItem>
  );
}

/** Point mode's compact Model XYZ line (#8770); the Point tab carries the full frame stack. */
export function MeasurePointHud() {
  const { t } = useTranslation();
  const pointMode = useViewerStore((s) => s.measureMode === 'point');
  const tracked = useMeasureLivePoint();
  const frame = useRenderFrameOffsets();
  if (!pointMode || !tracked) return null;
  const { world } = pointCoordinates(tracked.point, frame);

  return (
    <HudItem region="bottom-center" order={-1}>
      <HudSurface className="max-w-[92vw] px-2.5 py-1.5 text-xs" data-testid="measure-point-hud">
        <div className="flex items-baseline gap-2 whitespace-nowrap">
          <Crosshair aria-hidden className="h-3 w-3 shrink-0 self-center text-overlay-accent" />
          <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
            {tracked.live ? t('measure.readout.live') : t('measure.readout.last')}
            {!tracked.live && <StaleMeasurementBadge id={tracked.id} />}
          </span>
          <span className="text-2xs uppercase tracking-wider text-muted-foreground">
            {frame.rebased ? t('measure.point.rowAnchor') : t('measure.point.rowModel')}
          </span>
          <span className="font-mono tabular-nums">{formatCoordinateTriple(world)}</span>
          <span className="text-muted-foreground">{t('measure.geo.unitMeters')}</span>
        </div>
      </HudSurface>
    </HudItem>
  );
}

export function MeasureGeoReadout() {
  const { t } = useTranslation();
  const tracked = useMeasureLivePoint();
  const geoReadoutEnabled = useViewerStore((s) => s.geoReadoutEnabled);
  const anchor = useAnchorGeoreference();
  const showGeo = geoReadoutEnabled && anchor !== null;
  const livePoint = tracked?.point ?? null;
  // Hook order is fixed: called unconditionally, gated by its arguments.
  // Non-blocking: null until proj4 resolves, so E/N/H is unaffected.
  const latLon = useProjectedLatLon(showGeo ? livePoint : null, showGeo ? anchor : null);
  if (!showGeo || !anchor || !livePoint) return null;
  const enh = projectedEnh(livePoint, anchor);

  return (
    <HudItem region="bottom-center" order={0}>
      <HudSurface className="max-w-[92vw] px-2.5 py-1.5 text-xs" data-testid="measure-geo-readout">
        <div className="flex items-baseline gap-2 whitespace-nowrap">
          <Globe aria-hidden className="h-3 w-3 shrink-0 self-center text-overlay-accent" />
          <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
            {tracked?.live ? t('measure.readout.live') : t('measure.readout.last')}
            {tracked && !tracked.live && <StaleMeasurementBadge id={tracked.id} />}
          </span>
          {enh && <span className="font-mono tabular-nums">
            {t('measure.geo.easting')} {enh.e}
            <span className="ml-2">{t('measure.geo.northing')} {enh.n}</span>
            <span className="ml-2">{t('measure.geo.height')} {enh.h}</span>
            <span className="ml-1 text-muted-foreground">{t('measure.geo.unitMeters')}</span>
          </span>}
        </div>
        <div className="mt-0.5 pl-5 text-2xs tabular-nums text-muted-foreground">
          {anchor.eff.projectedCRS.name}
          {latLon && (
            <span className="ml-2">
              {t('measure.readout.latLon', { lat: latLon.lat.toFixed(6), lon: latLon.lon.toFixed(6) })}
            </span>
          )}
        </div>
      </HudSurface>
    </HudItem>
  );
}
