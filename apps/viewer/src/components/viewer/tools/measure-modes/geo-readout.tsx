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

import { useEffect, useState } from 'react';
import type { AnchorGeoreference } from '@/lib/geo/useAnchorGeoreference';
import { viewerPointToProjected } from '@/lib/geo/pick-to-geo';
import { mapUnitsToMeters } from '@/lib/geo/cesium-placement';
import {
  reprojectPointToLatLon,
  reprojectionInputKey,
  type LatLon,
} from '@/lib/geo/reproject';

export interface Vec3Like { x: number; y: number; z: number }
export interface Enh { e: string; n: string; h: string }

/**
 * Project a picked viewer point to real-world Eastings/Northings/Height and
 * format it in the CRS's metre unit to millimetre precision. The stored
 * MapConversion offsets are in the authored map unit (millimetres for the
 * bundled sample), so we convert to metres with the anchor's map-unit scale —
 * the raw offsets would read ~1000x too large for a metre CRS.
 */
export function projectedEnh(point: Vec3Like, anchor: AnchorGeoreference): Enh {
  const proj = viewerPointToProjected(point, anchor.eff, anchor.originViewer);
  const { projectedCRS, lengthUnitScale } = anchor.eff;
  return {
    e: mapUnitsToMeters(proj.eastings, projectedCRS, lengthUnitScale).toFixed(3),
    n: mapUnitsToMeters(proj.northings, projectedCRS, lengthUnitScale).toFixed(3),
    h: mapUnitsToMeters(proj.height, projectedCRS, lengthUnitScale).toFixed(3),
  };
}

/** One compact monospace E/N/H line, optionally labelled (A/B endpoints). */
export function EnhLine({ label, enh }: { label?: string; enh: Enh }) {
  return (
    <div className="flex items-center gap-2 font-mono text-[10px] leading-tight text-muted-foreground whitespace-nowrap">
      {label && <span className="text-muted-foreground/60 w-3 shrink-0">{label}</span>}
      <span>E {enh.e}</span>
      <span>N {enh.n}</span>
      <span>H {enh.h}</span>
    </div>
  );
}

/**
 * Resolve a picked viewer point to WGS84 lat/lon asynchronously (proj4). The
 * synchronous E/N/H readout never blocks on this; lat/lon appears once the
 * projection resolves and is `null` for a CRS proj4 can't resolve (the line is
 * simply absent). The effect is keyed by a primitive derived from *all* inputs
 * the reprojection consumes (CRS name + projection metadata + unit scales +
 * quantised E/N) so it recomputes on any georef edit but not on unrelated
 * re-renders — see {@link reprojectionInputKey}.
 */
export function useProjectedLatLon(
  point: Vec3Like | null,
  anchor: AnchorGeoreference | null,
): LatLon | null {
  const [latLon, setLatLon] = useState<LatLon | null>(null);
  const projected = point && anchor
    ? viewerPointToProjected(point, anchor.eff, anchor.originViewer)
    : null;
  const key = projected && anchor
    ? reprojectionInputKey(
        projected.eastings,
        projected.northings,
        anchor.eff.projectedCRS,
        anchor.eff.lengthUnitScale,
      )
    : '';

  useEffect(() => {
    if (!projected || !anchor) {
      setLatLon(null);
      return;
    }
    let cancelled = false;
    void reprojectPointToLatLon(
      projected.eastings,
      projected.northings,
      anchor.eff.projectedCRS,
      anchor.eff.lengthUnitScale,
    ).then((r) => {
      if (!cancelled) setLatLon(r);
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
