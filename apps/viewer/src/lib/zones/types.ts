/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Types for the "location zones" feature (issue #1810): user-defined 3D
 * boxes (construction sections, takt areas, ...) that elements get
 * classified into. Coordinates are in the VIEWER's world frame (Y-up,
 * see AGENTS.md "IFC is Z-up, the viewer is Y-up") because zones are
 * authored interactively against the rendered scene, not the IFC model.
 *
 * V1 is deliberately scoped: a zone is an oriented box (rotation about the
 * vertical/Y axis only — no pitch/roll), assignment is per-element
 * centroid-in-box with a "straddles" flag when the element's AABB crosses
 * a zone boundary, and no geometry is ever split. See `docs/design` (or the
 * PR description) for the full list of v1 exclusions.
 */

/** A single oriented box within a `ZoneSet`. */
export interface Zone {
  /** Stable id (UUID), unique across the whole app — element references use
   *  this, not array position, so reordering/renaming zones never silently
   *  re-targets an assignment. */
  id: string;
  /** Display name, e.g. "Section A" or "Level 03". */
  name: string;
  /** World-space center, viewer frame (Y-up), metres. */
  center: [x: number, y: number, z: number];
  /**
   * Full extents (not half-extents) along the box's own LOCAL axes, metres.
   * `size[1]` (the vertical/Y extent) is never rotated — `rotationY` only
   * spins the box's footprint (X/Z) around its center.
   */
  size: [dx: number, dy: number, dz: number];
  /** Rotation about the vertical (Y) axis, radians. Positive = counter-clockwise
   *  looking down the -Y axis (matches the renderer's right-handed Y-up frame). */
  rotationY: number;
  /** Optional display colour (0-1 RGB). Falls back to the parent set's
   *  palette-derived colour when absent. */
  color?: [r: number, g: number, b: number];
  /**
   * Optional CONVEX footprint in world X/Z metres (issue #2508 item 4). When
   * present the zone is a vertical PRISM over this polygon rather than a box:
   * `center[1] +/- size[1]/2` is still its vertical extent, and `rotationY` is
   * ignored because the polygon is already in world coordinates.
   *
   * `center` and `size` in X/Z stay the footprint's BOUNDING BOX, maintained by
   * whoever writes the footprint (`normalizePrismBounds`). Every existing
   * bounds consumer -- overlay culling, viewport framing, storey generation --
   * therefore keeps working unchanged and merely over-approximates, and the
   * exact tests refine it.
   *
   * Convexity is a REQUIREMENT, not a convention: the trapezoidal sweep, the
   * point test and the separating-axis overlap are each silently wrong for a
   * concave polygon. `isConvexFootprint` gates every entry point.
   */
  footprint?: ReadonlyArray<readonly [x: number, z: number]>;
}

/** A named, independent collection of zones (e.g. "Sections", "Takt areas").
 *  Multiple zone sets coexist; assignment runs per set independently, so an
 *  element can simultaneously belong to "Section 2" AND "Takt Area B". */
export interface ZoneSet {
  /** Stable id (UUID). */
  id: string;
  /** Display name, unique-by-convention but not enforced (last write wins in
   *  the UI; ids are what actually disambiguate). */
  name: string;
  zones: Zone[];
  /** Whether this set's boxes render in the 3D view. Independent of whether
   *  assignment runs — assignment always runs for every zone set so Lists /
   *  selection stay live even while the set's boxes are hidden. */
  visible: boolean;
  createdAt: number;
  updatedAt: number;
}

/** World-space axis-aligned bounding box of one element, the minimal input
 *  the assignment engine needs. `globalId` is the FederationRegistry id
 *  (stable across every loaded model; single-model fallback
 *  `globalId === expressId`). */
export interface ElementAABB {
  globalId: number;
  min: [x: number, y: number, z: number];
  max: [x: number, y: number, z: number];
}

/** Result of classifying one element against one zone set. */
export interface ZoneAssignment {
  /** The zone whose box contains the element's AABB centroid, or `null` when
   *  the centroid falls outside every zone in the set. */
  zoneId: string | null;
  zoneName: string | null;
  /** True when the element's AABB overlaps more than one zone in the set, or
   *  overlaps a zone other than the one containing its centroid (e.g. the
   *  centroid is in no zone but the element still pokes into one). Geometry
   *  is never split in v1 — this is purely an informational flag. */
  straddles: boolean;
  /** Every zone id whose box the element's AABB genuinely penetrates (past
   *  `STRADDLE_PENETRATION_M`), plus the home `zoneId` above when set (the
   *  home zone counts as touched even when the element is too thin to clear
   *  the penetration threshold). Empty when the element touches no zone at
   *  all. */
  touchedZoneIds: string[];
}

/** Per-element assignment across every zone set, keyed by zone-set id. */
export type ZoneAssignmentsByElement = Map<number, Record<string, ZoneAssignment>>;

// ============================================================================
// Persistence (versioned JSON, kept out of the IFC model in v1)
// ============================================================================

/** Current on-disk schema version. Bump whenever the shape of `Zone` /
 *  `ZoneSet` changes in a way older readers can't tolerate, and add a
 *  migration in `persistence.ts` rather than breaking old exports. */
export const ZONE_SET_FILE_VERSION = 1 as const;

export interface ZoneSetFileV1 {
  version: 1;
  /** ISO timestamp of export, informational only. */
  exportedAt: string;
  zoneSets: ZoneSet[];
}

export type ZoneSetFile = ZoneSetFileV1;
