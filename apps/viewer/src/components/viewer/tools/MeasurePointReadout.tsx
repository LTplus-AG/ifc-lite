/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coordinates of the Measure tool's live point — issue #2199 §5.
 *
 * The point is whichever one the tool is already tracking: the moving end of
 * the current drag, or the last finalized endpoint when nothing is being
 * dragged. Nothing here re-picks and nothing here adds an interaction; it is
 * the same point the georeferenced E/N/H box has always shown, expressed in
 * the frames §5 asks for.
 *
 * Frames are stacked from the most local outwards, and a frame is shown only
 * when it says something the one above it did not:
 *
 * - **Model** — the file's own coordinates, IFC Z-up. Always shown; this is
 *   the one that was missing entirely before #2199. Relabelled **Anchor** in a
 *   federation whose alignment re-based another model into the scene frame:
 *   there, a picked point (which belongs to no model — it is wherever the
 *   cursor hit) comes back in the ANCHOR file's coordinate system, and calling
 *   that "Model" would name a file the numbers may not belong to.
 * - **Render** — the shifted frame the renderer works in. Shown only when the
 *   pipeline actually shifted the model, since otherwise it is the same row
 *   twice under two labels.
 * - **Reference** — offset from a user-set datum. Shown once one is set.
 * - **Map** — projected E/N/H and WGS84 lat/lon. Unchanged from #1674/#1679,
 *   and still gated on the Geo XYZ toggle and a usable IfcMapConversion.
 */

import { Crosshair, Globe, MapPin, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { useRenderFrameOffsets } from '@/hooks/useRenderFrameOffsets';
import { useAnchorGeoreference } from '@/lib/geo/useAnchorGeoreference';
import {
  pointCoordinates,
  relativeOffset,
  viewerToIfcAxes,
  formatCoordinateTriple,
} from './measure-modes/coordinates';
import { formatDistance, formatSignedTriple } from './formatDistance';
import { projectedEnh, useProjectedLatLon, type Vec3Like } from './measure-modes/geo-readout';

/** One labelled coordinate row. */
function CoordRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2 whitespace-nowrap">
      <span className="w-[4.5rem] shrink-0 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70">
        {label}
      </span>
      <span className="font-mono text-[11px] tabular-nums">{value}</span>
      {hint && <span className="font-mono text-[9px] text-muted-foreground/60">{hint}</span>}
    </div>
  );
}

export function MeasurePointReadout() {
  const activeMeasurement = useViewerStore((s) => s.activeMeasurement);
  const measurements = useViewerStore((s) => s.measurements);
  const geoReadoutEnabled = useViewerStore((s) => s.geoReadoutEnabled);
  const referencePoint = useViewerStore((s) => s.measureReferencePoint);
  const setReferencePoint = useViewerStore((s) => s.setMeasureReferencePoint);
  const unitDisplayOverrides = useViewerStore((s) => s.unitDisplayOverrides);

  const frame = useRenderFrameOffsets();
  const anchor = useAnchorGeoreference();

  // The live point: the moving end of the current drag, else the most recent
  // finalized endpoint. Same rule the georeferenced box has always used.
  const livePoint: Vec3Like | null = activeMeasurement?.current
    ?? (measurements.length > 0 ? measurements[measurements.length - 1].end : null);

  const showGeo = geoReadoutEnabled && anchor !== null;
  // Hook order is fixed: called unconditionally, gated by its arguments.
  const latLon = useProjectedLatLon(showGeo ? livePoint : null, showGeo ? anchor : null);

  if (!livePoint) {
    return (
      <div className="border-t px-2 py-2 text-center text-[10px] text-muted-foreground">
        Measure a point to read its coordinates
      </div>
    );
  }

  const coords = pointCoordinates(livePoint, frame);
  // The reference point is stored in renderer space, so it is converted to IFC
  // axes here rather than being subtracted in one frame and displayed in
  // another — mixing the two would negate the northing delta.
  const offset = referencePoint
    ? relativeOffset(coords.local, viewerToIfcAxes(referencePoint))
    : null;
  const enh = showGeo && anchor ? projectedEnh(livePoint, anchor) : null;

  return (
    <div className="border-t px-2 py-2 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-primary">
          <Crosshair className="h-3 w-3" />
          {activeMeasurement ? 'Live point' : 'Last point'}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            title="Set this point as the relative-coordinate reference"
            onClick={() => setReferencePoint({ x: livePoint.x, y: livePoint.y, z: livePoint.z })}
          >
            <MapPin className="h-3 w-3" />
          </Button>
          {referencePoint && (
            <Button
              variant="ghost"
              size="icon-sm"
              title="Clear the reference point"
              onClick={() => setReferencePoint(null)}
            >
              <XCircle className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <CoordRow
          label={frame.rebased ? 'Anchor' : 'Model'}
          value={formatCoordinateTriple(coords.world)}
          hint="m"
        />
        {/* Only when the pipeline actually shifted the model — otherwise this
            is the Model row again under a different name. */}
        {coords.shifted && (
          <CoordRow label="Render" value={formatCoordinateTriple(coords.local)} hint="m" />
        )}
        {offset && (
          <CoordRow
            label="Rel. ref"
            // dx/dy/dz are a LENGTH DELTA, not a raw model coordinate — unlike
            // the Model/Render/Map rows above, this triple must honour the
            // same LENGTHUNIT override as the trailing distance hint, or the
            // two disagree (#2538 deep review).
            value={formatSignedTriple({ x: offset.dx, y: offset.dy, z: offset.dz }, unitDisplayOverrides)}
            hint={formatDistance(offset.distance, unitDisplayOverrides)}
          />
        )}
        {enh && (
          <CoordRow label="Map" value={`E ${enh.e}  N ${enh.n}  H ${enh.h}`} hint="m" />
        )}
        {latLon && (
          <CoordRow
            label="Lat / Lon"
            value={`${latLon.lat.toFixed(6)}  ${latLon.lon.toFixed(6)}`}
          />
        )}
      </div>

      {frame.rebased && (
        <div className="font-mono text-[9px] leading-tight text-muted-foreground/70">
          Federation alignment re-based one or more models into
          {frame.anchorName ? ` ${frame.anchorName}` : ' the anchor model'}'s frame,
          so these are anchor coordinates, not necessarily the picked file's own.
        </div>
      )}

      {enh && anchor && (
        <div className="flex items-center gap-1 font-mono text-[9px] text-muted-foreground/70">
          <Globe className="h-2.5 w-2.5" />
          {anchor.eff.projectedCRS.name}
        </div>
      )}
    </div>
  );
}
