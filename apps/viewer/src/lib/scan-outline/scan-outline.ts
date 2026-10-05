/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Vector outline of the scan section slab (#6871): the wasm `traceScanOutline`
 * binding, run on the in-band points the scan section layer already gathers,
 * read back into plain drawing-space rings and freed before returning.
 *
 * The points come from `collectScanBandPlaneXY`, i.e. the same drawing space
 * as `Drawing2D.lines` / `cutPolygons`, so the rings composite with the cut
 * and go through the DXF export's shared georeference transform
 * (`dxfExportGeoref.ts`) unchanged. No plane frame is passed: the viewer never
 * needs 3D coordinates for these rings.
 */

import { traceScanOutline, type ScanOutlineDiagnosticsJs } from '@ifc-lite/wasm';
import type { DXFPolylineLayer, Point2D } from '@ifc-lite/drawing-2d';

/** Default widest gap the outline bridges (metres): about a wall thickness. */
export const DEFAULT_SCAN_OUTLINE_MAX_GAP = 0.3;
/** Slider bounds for the bridge distance; the Rust side clamps at 0.5 m. */
export const SCAN_OUTLINE_MAX_GAP_MIN = 0.05;
export const SCAN_OUTLINE_MAX_GAP_MAX = 0.5;

export interface ScanOutlineLayer {
  /** Closed rings in drawing space, no closing duplicate. */
  rings: Point2D[][];
  /** Per ring: a hole of the shape before it (from the trace's nesting, not winding). */
  holes: boolean[];
  diagnostics: ScanOutlineDiagnosticsJs;
}

/** DXF layer the traced outline is written on. */
export const SCAN_OUTLINE_DXF_LAYER = 'SCAN-OUTLINE';
/** Stroke colour of the outline, on screen and in DXF (teal, like the panel's controls). */
export const SCAN_OUTLINE_COLOR = '#0d9488';

/** The outline as the DXF exporter's extra layer; none without rings. */
export function scanOutlineDxfLayers(outline: ScanOutlineLayer | null | undefined): DXFPolylineLayer[] {
  if (!outline || outline.rings.length === 0) return [];
  return [{ name: SCAN_OUTLINE_DXF_LAYER, color: SCAN_OUTLINE_COLOR, polylines: outline.rings, closed: true }];
}

/**
 * Trace the outline of `planeXY` (flat drawing-space `[x0, y0, …]`). The wasm
 * module must be initialised (`ensureWasm` from `@/lib/wasm/ensure-wasm`). Throws on invalid
 * options, never on degenerate input (that gives zero rings).
 */
export function traceScanOutlineLayer(planeXY: Float32Array, maxGap: number): ScanOutlineLayer {
  const handle = traceScanOutline(planeXY, { maxGap });
  try {
    const coords = handle.coords();
    const lengths = handle.ringLengths();
    const shapeStarts = new Set(handle.shapeOffsets());
    const rings: Point2D[][] = [];
    const holes: boolean[] = [];
    let at = 0;
    lengths.forEach((n, r) => {
      const ring: Point2D[] = [];
      for (let k = 0; k < n; k++) ring.push({ x: coords[(at + k) * 2], y: coords[(at + k) * 2 + 1] });
      rings.push(ring);
      holes.push(!shapeStarts.has(r));
      at += n;
    });
    return { rings, holes, diagnostics: handle.diagnostics() };
  } finally {
    handle.free();
  }
}
