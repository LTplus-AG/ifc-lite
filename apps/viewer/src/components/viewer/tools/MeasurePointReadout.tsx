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
 * - **Datum** — the temporary reference point itself (#2737 §3), as a position
 *   in the SAME frame and format as the Model row above, because that is what
 *   it is: a point somebody picked. Shown once one is set.
 * - **Relative** — the live point's offset FROM that datum. Also shown only
 *   once one is set, and printed as signed per-axis deltas (`ΔX +2.500`) so it
 *   cannot be read as a position. The two rows ship together on purpose: an
 *   offset whose origin is off-screen or forgotten is a number nobody can act
 *   on, so the datum is never left implied by the delta row's existence.
 * - **Map** — projected E/N/H and WGS84 lat/lon. Unchanged from #1674/#1679,
 *   and still gated on the Geo XYZ toggle and a usable IfcMapConversion.
 *
 * Only the Relative row is a delta; every other row is a position, and no
 * datum is ever subtracted from one. A relative reading and a georeferenced
 * one are therefore never the same number wearing different labels.
 */

import { Crosshair, Globe, MapPin, XCircle } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n/useTranslation';
// Side-effect import: merges the measure catalogue into the runtime `en`
// object so `t('measure.*')` resolves under the real 'en' locale (see that
// module's own doc comment).
import { useRenderFrameOffsets } from '@/hooks/useRenderFrameOffsets';
import { useAnchorGeoreference } from '@/lib/geo/useAnchorGeoreference';
import {
  pointCoordinates,
  relativeOffset,
  formatCoordinateTriple,
} from './measure-modes/coordinates';
import { viewerToIfcAxes } from '@/lib/geo/coordinate-frame';
import { formatDistance, formatSignedTriple } from './formatDistance';
import { projectedEnh, useProjectedLatLon, type Vec3Like } from './measure-modes/geo-readout';

/** One labelled coordinate row. */
function CoordRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2 whitespace-nowrap">
      <span className="w-[4.5rem] shrink-0 font-mono text-2xs uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-2xs tabular-nums">{value}</span>
      {hint && <span className="font-mono text-2xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

export function MeasurePointReadout() {
  const { t } = useTranslation();
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
      <div className="px-3 py-8 text-center text-xs text-muted-foreground">
        {t('measure.point.emptyPrompt')}
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
  // The datum's own position, resolved through the SAME frame reconstruction
  // as the live point so the two rows are comparable by eye. Derived on every
  // render from the store rather than captured when the datum was set: moving
  // or clearing the reference re-renders this component, so a displayed offset
  // and the datum printed beside it can never disagree with each other or
  // outlive the datum they were taken from.
  const datum = referencePoint ? pointCoordinates(referencePoint, frame) : null;
  const enh = showGeo && anchor ? projectedEnh(livePoint, anchor) : null;

  return (
    <div className="space-y-1.5 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 font-mono text-2xs uppercase tracking-wider text-foreground">
          <Crosshair className="h-3 w-3" />
          {activeMeasurement ? t('measure.point.live') : t('measure.point.last')}
        </span>
        <div className="flex items-center gap-1">
          <IconButton
            variant="ghost"
            size="icon-sm"
            label={t('measure.point.setReferenceTitle')}
            onClick={() => setReferencePoint({ x: livePoint.x, y: livePoint.y, z: livePoint.z })}
          >
            <MapPin className="h-3 w-3" />
          </IconButton>
          {referencePoint && (
            <IconButton
              variant="ghost"
              size="icon-sm"
              label={t('measure.point.clearReferenceTitle')}
              onClick={() => setReferencePoint(null)}
            >
              <XCircle className="h-3 w-3" />
            </IconButton>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <CoordRow
          label={frame.rebased ? t('measure.point.rowAnchor') : t('measure.point.rowModel')}
          value={formatCoordinateTriple(coords.world)}
          hint="m"
        />
        {/* Only when the pipeline actually shifted the model — otherwise this
            is the Model row again under a different name. */}
        {coords.shifted && (
          <CoordRow label={t('measure.point.rowRender')} value={formatCoordinateTriple(coords.local)} hint="m" />
        )}
        {datum && (
          <CoordRow
            label={t('measure.point.rowDatum')}
            // A position, not a delta — same frame, same formatter, same
            // unlabelled metres as the Model row, because reading the two
            // against each other is the point of showing it at all.
            value={formatCoordinateTriple(datum.world)}
            hint="m"
          />
        )}
        {offset && (
          <CoordRow
            label={t('measure.point.rowRelative')}
            // dx/dy/dz are a LENGTH DELTA, not a raw model coordinate — unlike
            // the Model/Render/Map rows above, this triple must honour the
            // same LENGTHUNIT override as the trailing distance hint, or the
            // two disagree (#2538 deep review).
            value={formatSignedTriple({ x: offset.dx, y: offset.dy, z: offset.dz }, unitDisplayOverrides)}
            hint={formatDistance(offset.distance, unitDisplayOverrides)}
          />
        )}
        {enh && (
          <CoordRow
            label={t('measure.point.rowMap')}
            value={`${t('measure.geo.easting')} ${enh.e}  ${t('measure.geo.northing')} ${enh.n}  ${t('measure.geo.height')} ${enh.h}`}
            hint="m"
          />
        )}
        {latLon && (
          <CoordRow
            label={t('measure.point.rowLatLon')}
            value={`${latLon.lat.toFixed(6)}  ${latLon.lon.toFixed(6)}`}
          />
        )}
      </div>

      {frame.rebased && (
        <div className="font-mono text-2xs leading-tight text-muted-foreground">
          {t('measure.point.rebasedNote', {
            name: frame.anchorName ? frame.anchorName : t('measure.point.anchorModelFallback'),
          })}
        </div>
      )}

      {enh && anchor && (
        <div className="flex items-center gap-1 font-mono text-2xs text-muted-foreground">
          <Globe className="h-2.5 w-2.5" />
          {anchor.eff.projectedCRS.name}
        </div>
      )}
    </div>
  );
}
