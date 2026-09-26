/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Measure tool's two bottom-center HUD items (#5502): the one hint line
 * (`HudHint`, bare text, order 1 — nearest the bottom edge) and, above it,
 * the live real-world XYZ readout on the shared card surface (order 0),
 * shown only while Geo XYZ is on and the anchor model is georeferenced.
 */

import { Globe } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n/useTranslation';
import { useAnchorGeoreference } from '@/lib/geo/useAnchorGeoreference';
import { HudHint, HudItem, HudSurface } from '../../viewport-ui/hud';
import { measureHintKey } from './measure-modes/readouts';
import { projectedEnh, useProjectedLatLon, type Vec3Like } from './measure-modes/geo-readout';

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
    }),
  );
  return (
    <HudItem region="bottom-center" order={1}>
      <HudHint>{t(key)}</HudHint>
    </HudItem>
  );
}

export function MeasureGeoReadout() {
  const { t } = useTranslation();
  const activeMeasurement = useViewerStore((s) => s.activeMeasurement);
  const measurements = useViewerStore((s) => s.measurements);
  const geoReadoutEnabled = useViewerStore((s) => s.geoReadoutEnabled);
  const anchor = useAnchorGeoreference();
  const showGeo = geoReadoutEnabled && anchor !== null;
  // The live point: the moving end of the current drag, else the most
  // recently finalized endpoint.
  const livePoint: Vec3Like | null =
    activeMeasurement?.current ?? (measurements.length > 0 ? measurements[measurements.length - 1].end : null);
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
            {activeMeasurement ? t('measure.readout.live') : t('measure.readout.last')}
          </span>
          <span className="font-mono tabular-nums">
            {t('measure.geo.easting')} {enh.e}
            <span className="ml-2">{t('measure.geo.northing')} {enh.n}</span>
            <span className="ml-2">{t('measure.geo.height')} {enh.h}</span>
            <span className="ml-1 text-muted-foreground">{t('measure.geo.unitMeters')}</span>
          </span>
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
