/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Georeferenced readout for a picked point (#1657 / #1674 / #1679), extracted
 * from `MeasurePanel` so the panel, the measurement list rows and the
 * point-coordinates card can all reach it without importing each other.
 *
 * Behaviour is unchanged by the move — this is the same projection, the same
 * unit handling and the same async lat/lon effect that shipped in #1674/#1679.
 */

import { useEffect, useMemo, useState } from 'react';
import type { AnchorGeoreference } from '@/lib/geo/useAnchorGeoreference';
import { viewerPointToProjected } from '@/lib/geo/pick-to-geo';
import { mapUnitsToMeters } from '@/lib/geo/cesium-placement';
import {
  reprojectPointToLatLon,
  resolveProjection,
  type LatLon,
} from '@/lib/geo/reproject';
import { useTranslation } from '@/i18n/useTranslation';
import { createCesiumBridge } from '@/lib/geo/cesium-bridge';
import { isGeographicProj4 } from '@/lib/geo/proj4-utils';
import { useViewerStore } from '@/store';
// Side-effect import: merges the measure catalogue into the runtime `en`
// object so `t('measure.*')` resolves under the real 'en' locale (see that
// module's own doc comment).

export interface Vec3Like { x: number; y: number; z: number }
export interface Enh { e: string; n: string; h: string }

/**
 * Project a picked viewer point to real-world Eastings/Northings/Height and
 * format it in the CRS's metre unit to millimetre precision. The stored
 * MapConversion offsets are in the authored map unit (millimetres for the
 * bundled sample), so we convert to metres with the anchor's map-unit scale —
 * the raw offsets would read ~1000x too large for a metre CRS.
 */
export function projectedEnh(point: Vec3Like, anchor: AnchorGeoreference): Enh | null {
  // Angular XY has no projected metre E/N row. Its physical picked-point
  // latitude/longitude is resolved through the model's geographic frame.
  if (anchor.geographic) return null;
  const proj = viewerPointToProjected(point, anchor.eff, anchor.originViewer);
  const { projectedCRS, lengthUnitScale } = anchor.eff;
  return {
    e: mapUnitsToMeters(proj.eastings, projectedCRS, lengthUnitScale).toFixed(3),
    n: mapUnitsToMeters(proj.northings, projectedCRS, lengthUnitScale).toFixed(3),
    h: mapUnitsToMeters(proj.height, projectedCRS, lengthUnitScale).toFixed(3),
  };
}

/** One compact monospace E/N/H line, optionally labelled (A/B endpoints). */
export function EnhLine({ label, enh }: { label?: string; enh: Enh | null }) {
  const { t } = useTranslation();
  if (!enh) return null;
  return (
    <div className="flex items-center gap-2 font-mono text-2xs leading-tight text-muted-foreground whitespace-nowrap">
      {label && <span className="text-muted-foreground w-3 shrink-0">{label}</span>}
      <span>{t('measure.geo.easting')} {enh.e}</span>
      <span>{t('measure.geo.northing')} {enh.n}</span>
      <span>{t('measure.geo.height')} {enh.h}</span>
    </div>
  );
}

/**
 * Resolve a picked viewer point to WGS84 lat/lon. Projected anchors use their
 * raw map coordinates; geographic anchors use the shared physical model
 * frame, whose geometry is measured in metres around an angular center pin.
 * A stable frame promise survives point motion, while any frame or point edit
 * clears the old readout until the new position resolves.
 */
export function useProjectedLatLon(
  point: Vec3Like | null,
  anchor: AnchorGeoreference | null,
): LatLon | null {
  const [latLon, setLatLon] = useState<LatLon | null>(null);
  const heightsAreEllipsoidal = useViewerStore((s) => s.cesiumHeightsAreEllipsoidal);
  const coordinateInfo = anchor?.eff.coordinateInfo ?? anchor?.coordinateInfo;
  // A frame depends on every conversion coefficient and the actual geometry
  // center, origin shift and RTC. Point motion reuses this promise; changing
  // any frame input constructs a new bridge, including height-only edits.
  const frameKey = anchor ? JSON.stringify([
    anchor.eff.mapConversion, anchor.eff.projectedCRS, coordinateInfo, anchor.eff.lengthUnitScale,
    // Projected XY never depends on height mode. Geographic XY is derived
    // from the physical ECEF model matrix, including its ellipsoidal altitude.
    anchor.geographic === false ? undefined : heightsAreEllipsoidal,
  ]) : '';
  const frame = useMemo(() => anchor ? resolveProjection(anchor.eff.projectedCRS).then(async (definition) => {
    if (!definition) return null;
    if (!isGeographicProj4(definition)) return { geographic: false as const, bridge: null };
    const bridge = await createCesiumBridge(anchor.eff.mapConversion, anchor.eff.projectedCRS,
      coordinateInfo, anchor.eff.lengthUnitScale, undefined, heightsAreEllipsoidal);
    return { geographic: true as const, bridge };
  }).catch((error: unknown) => {
    console.warn('[measure] geographic frame resolution failed', error);
    return null;
  }) : null,
  // The serialized frame key tracks values even when callers mutate an object.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [frameKey]);
  const key = point && anchor ? JSON.stringify([frameKey, point, anchor.originViewer]) : '';

  useEffect(() => {
    if (!point || !anchor || !frame) {
      setLatLon(null);
      return;
    }
    // Drop the PREVIOUS point's lat/lon before the async hop. Without this the
    // readout keeps showing the last resolved coordinates while the new ones
    // are in flight — a stale position under a fresh label, which is worse
    // than a momentarily absent row.
    setLatLon(null);
    let cancelled = false;
    void frame.then(async (resolved) => {
      if (!resolved) return null;
      if (resolved.geographic) {
        const picked = resolved.bridge?.viewerToGeodetic(point.x, point.y, point.z);
        return picked ? { lat: picked.latitude, lon: picked.longitude } : null;
      }
      const projected = viewerPointToProjected(point, anchor.eff, anchor.originViewer);
      return reprojectPointToLatLon(projected.eastings, projected.northings,
        anchor.eff.projectedCRS, anchor.eff.lengthUnitScale);
    }).then((r) => {
      if (!cancelled) setLatLon(r);
    }).catch((error: unknown) => {
      console.warn('[measure] picked-point reprojection failed', error);
      if (!cancelled) setLatLon(null);
    });
    return () => {
      cancelled = true;
    };
    // Keyed by the primitive `key` so unrelated re-renders don't refetch and a
    // georef change that alters the projection always does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return latLon;
}
