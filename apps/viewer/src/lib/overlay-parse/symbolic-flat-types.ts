/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


/**
 * The whole symbolic collection as transferable arrays.
 *
 * Variable-length data (curve points, fill rings, fill holes) is concatenated
 * into one buffer per kind with a companion `*Start` offset array of length
 * `N + 1`: item `i` spans `[start[i], start[i + 1])`. Fixed-width per-item data
 * is one entry per item, or a fixed stride where noted.
 *
 * Every array is backed by its own `ArrayBuffer`, so the whole struct can be
 * handed to `postMessage` as a transfer list.
 */
export interface FlatSymbolic {
  /**
   * IFC type names, deduplicated. The per-primitive `*Type` arrays index into
   * this. Under `'overlay'` it holds at most `IfcAnnotation` and `IfcGridAxis`;
   * under `'all'` it holds every product type the model authored a symbolic
   * representation for, which is why the index arrays are 16-bit — an 8-bit
   * index would wrap silently past 256 distinct types and hand a primitive
   * somebody else's `ifcType`.
   */
  typeNames: string[];

  // ── Polylines ────────────────────────────────────────────────────────────
  /** Flat `[x, y, x, y, …]` for every polyline, back to back. */
  polyPoints: Float32Array;
  /** `N + 1` **point**-index offsets into `polyPoints` (float index = 2×). */
  polyStart: Uint32Array;
  /** Express id of the owning entity, one per polyline. */
  polyOwner: Uint32Array;
  /** `worldY` placement elevation, one per polyline. */
  polyWorldY: Float32Array;
  /** Bit 0 = `isClosed`. One per polyline. */
  polyFlags: Uint8Array;
  /** Index into {@link FlatSymbolic.typeNames}, one per polyline. */
  polyType: Uint16Array;

  // ── Circles / arcs ───────────────────────────────────────────────────────
  circleCenterX: Float32Array;
  circleCenterY: Float32Array;
  circleRadius: Float32Array;
  circleStartAngle: Float32Array;
  circleEndAngle: Float32Array;
  circleOwner: Uint32Array;
  circleWorldY: Float32Array;
  /** Bit 0 = `isFullCircle`. One per circle. */
  circleFlags: Uint8Array;
  circleType: Uint16Array;

  // ── Texts ────────────────────────────────────────────────────────────────
  /** Raw IFC literal, still STEP-escaped — decoded on the main thread. */
  textContent: string[];
  /** Raw IFC `BoxAlignment` string, one per text. */
  textAlignment: string[];
  textX: Float32Array;
  textY: Float32Array;
  textDirX: Float32Array;
  textDirY: Float32Array;
  textHeight: Float32Array;
  textTargetPx: Float32Array;
  /** Stride 4: `[r, g, b, a]` per text. `a <= 0` means "no authored colour". */
  textColor: Float32Array;
  textOwner: Uint32Array;
  textWorldY: Float32Array;
  textType: Uint16Array;

  // ── Fills ────────────────────────────────────────────────────────────────
  /** Flat ring vertices for every fill, back to back. */
  fillPoints: Float32Array;
  /**
   * `N + 1` **float**-index offsets into `fillPoints`. Float indices rather
   * than vertex indices because the main-side `points.length < 6` guard reads
   * the raw array length WASM produced; deriving the span from `pointCount`
   * would silently drop a trailing odd float and move that boundary.
   */
  fillPointStart: Uint32Array;
  /** Hole start vertex indices, relative to each fill's own ring buffer. */
  fillHoles: Uint32Array;
  /** `N + 1` offsets into `fillHoles`. */
  fillHoleStart: Uint32Array;
  /** Stride 4: `[r, g, b, a]` per fill. */
  fillColor: Float32Array;
  /**
   * Stride 4: `[spacing, angle, angleSecondary, lineWidth]` per fill. Only
   * meaningful when bit 0 of {@link FlatSymbolic.fillFlags} is set;
   * `angleSecondary` carries `NaN` when the style had no secondary angle.
   */
  fillHatch: Float32Array;
  fillOwner: Uint32Array;
  /** Direct fill item ID; zero means unavailable, never a matching wildcard. */
  fillGeometryItem: Uint32Array;
  fillWorldY: Float32Array;
  /** Bit 0 = `hasHatching`. One per fill. */
  fillFlags: Uint8Array;
  fillType: Uint16Array;
}

