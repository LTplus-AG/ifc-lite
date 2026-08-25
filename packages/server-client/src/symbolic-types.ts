/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The symbolic (2D drawing) wire shapes of the parse response.
 *
 * Split out of `types.ts` under the module-size ratchet (#3199): the family is
 * self-contained -- nothing here references a mesh, a spatial node or a
 * property -- and `types.ts` re-exports it, so the package's public surface is
 * unchanged and every existing `from '@ifc-lite/server-client'` import keeps
 * resolving. Mirrors the same split made in `@ifc-lite/geometry`.
 */

/**
 * A single `IfcGridAxis` tag + axis curve (compact endpoint-pair shape).
 */
export interface SymbolicGridAxis {
  express_id: number;
  grid_express_id: number;
  tag: string;
  /** Endpoint pair `[x0, y0, x1, y1]` in metres (plan view). */
  endpoints: [number, number, number, number];
  /**
   * World-Y elevation in metres, or `null` when unresolved. See the
   * "UNRESOLVED SCALARS" note at the top of this section — `null` is not `0`.
   */
  world_y: number | null;
}

/**
 * A 2D polyline (`IfcPolyline`, `IfcIndexedPolyCurve`, tessellated ellipses,
 * trimmed-curve arcs, grid axis lines).
 */
export interface SymbolicPolyline {
  express_id: number;
  ifc_type: string;
  /** Flat `[x0, y0, x1, y1, …]` plan-view coordinates. */
  points: number[];
  closed: boolean;
  /**
   * World-Y elevation in metres, or `null` when unresolved. See the
   * "UNRESOLVED SCALARS" note at the top of this section — `null` is not `0`.
   */
  world_y: number | null;
  representation: string;
}

/**
 * A 2D circle / arc (`IfcCircle`).
 */
export interface SymbolicCircle {
  express_id: number;
  ifc_type: string;
  center_x: number;
  center_y: number;
  radius: number;
  /**
   * World-Y elevation in metres, or `null` when unresolved. See the
   * "UNRESOLVED SCALARS" note at the top of this section — `null` is not `0`.
   */
  world_y: number | null;
  /** Start angle in radians (0 for a full circle). */
  start_angle: number;
  /** End angle in radians (`2π` for a full circle). */
  end_angle: number;
  representation: string;
}

/**
 * A 2D text annotation (`IfcTextLiteral` / grid bubble glyphs + tags).
 */
export interface SymbolicText {
  express_id: number;
  ifc_type: string;
  x: number;
  y: number;
  /** Baseline orientation as a `(cos, sin)` pair. */
  dir_x: number;
  dir_y: number;
  /** Font cap height in model units (already unit-scaled). */
  height: number;
  content: string;
  /** IFC `BoxAlignment` (`top-left`, `center`, …). Empty when absent. */
  alignment: string;
  /**
   * World-Y elevation in metres, or `null` when unresolved. See the
   * "UNRESOLVED SCALARS" note at the top of this section — `null` is not `0`.
   */
  world_y: number | null;
  /** sRGB straight-alpha colour `[r, g, b, a]`. */
  color: [number, number, number, number];
  /** Per-instance target screen-pixel cap height (`0` = renderer default). */
  target_px: number;
  representation: string;
}

/**
 * A 2D filled region (`IfcAnnotationFillArea`). Outer ring + optional holes
 * packed into a single `points` buffer; `holes_offsets[i]` is the vertex index
 * where hole `i` begins.
 */
export interface SymbolicFillArea {
  express_id: number;
  ifc_type: string;
  points: number[];
  holes_offsets: number[];
  fill_color: [number, number, number, number];
  has_hatching: boolean;
  hatch_spacing: number;
  hatch_angle: number;
  /**
   * Secondary cross-hatch angle. `null` when absent — the Rust model uses
   * `f32::NAN`, which `serde_json` serializes as JSON `null` (not `NaN`).
   */
  hatch_angle_secondary: number | null;
  hatch_line_width: number;
  /**
   * World-Y elevation in metres, or `null` when unresolved. See the
   * "UNRESOLVED SCALARS" note at the top of this section — `null` is not `0`.
   */
  world_y: number | null;
  representation: string;
}

/**
 * 2D symbol data extracted from `IfcAnnotation` and `IfcGrid` entities.
 *
 * Returned inline by `POST /api/v1/parse` and the streaming `complete` events,
 * and fetched by cache key from `GET /api/v1/parse/symbolic/{cache_key}` for the
 * binary (Parquet) transports. Arrays may be empty when the model carries no
 * 2D symbols.
 */
/**
 * Present only when extraction stopped at its bound; absent when the file was
 * emitted in full.
 */
/**
 * Which bound stopped an extraction early.
 *
 * Mirrors `SymbolicTruncationReason` in `rust/processing/src/symbolic/output_cap.rs`,
 * serialized kebab-case. The extraction bounds (`element-count`, `output-bytes`)
 * are the severe ones and outrank the per-item bounds, which stop one
 * representation item's contribution while the whole-file totals can sit far
 * below either extraction bound.
 */
export type SymbolicTruncationReason =
  | 'element-count'
  | 'output-bytes'
  | 'item-depth'
  | 'item-revisits'
  | 'item-cycle';

export interface SymbolicTruncation {
  /** Which bound fired. */
  reason: SymbolicTruncationReason;
  /** Total primitives emitted. */
  emitted: number;
  /**
   * The bound's numeric value, when the reason has one.
   *
   * ABSENT for `item-depth`, `item-revisits` and `item-cycle`: those bounds
   * count traversal revisits and nesting depth, not emitted primitives, so
   * there is no number to compare `emitted` against without inventing one.
   */
  limit?: number;
}

export interface SymbolicData {
  grid_axes: SymbolicGridAxis[];
  polylines: SymbolicPolyline[];
  circles: SymbolicCircle[];
  texts: SymbolicText[];
  fills: SymbolicFillArea[];
  /**
   * Set when the server bounded this extraction and returned a partial result.
   *
   * Optional because it is omitted for a complete extraction, so an existing
   * consumer keeps compiling. But a consumer that renders symbolic geometry
   * without reading this shows a clipped drawing as though it were the whole
   * drawing, which is the failure this field exists to end.
   */
  truncated?: SymbolicTruncation;
}
