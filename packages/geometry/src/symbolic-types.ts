/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The symbolic-representation type family, split out of `types.ts` (#3199).
 *
 * Moved rather than trimmed: `types.ts` sat EXACTLY at its module-size budget,
 * and the TS allowlist is explicit that budgets ratchet DOWN by default -- a
 * raise is sanctioned but deliberate, and wants a per-file justification in the
 * PR, which a split does not. This family is self-contained -- nothing
 * imports it from `types.ts`, and the names the package root exposes come from
 * `ifc-lite-bridge.ts` -- so it is the natural seam. `types.ts` re-exports it,
 * so the public surface is unchanged.
 */

/**
 * Representation identifier types for symbolic representations
 */
export type SymbolicRepIdentifier = 'Plan' | 'Annotation' | 'FootPrint' | 'Axis';

/**
 * A 2D polyline from symbolic representations
 * Used for door swings, window cuts, equipment symbols, etc.
 */
export interface SymbolicPolyline {
  /** Express ID of the parent IFC element */
  expressId: number;
  /** IFC type name (e.g., "IfcDoor", "IfcWindow") */
  ifcType: string;
  /** 2D points as Float32Array [x1, y1, x2, y2, ...] */
  points: Float32Array;
  /** Number of points in the polyline */
  pointCount: number;
  /** Whether this is a closed loop */
  isClosed: boolean;
  /** Representation identifier ("Plan", "Annotation", etc.) */
  repIdentifier: string;
}

/**
 * A 2D circle or arc from symbolic representations
 */
export interface SymbolicCircle {
  /** Express ID of the parent IFC element */
  expressId: number;
  /** IFC type name */
  ifcType: string;
  /** Center X coordinate */
  centerX: number;
  /** Center Y coordinate */
  centerY: number;
  /** Radius */
  radius: number;
  /** Start angle in radians (0 for full circle) */
  startAngle: number;
  /** End angle in radians (2π for full circle) */
  endAngle: number;
  /** Whether this is a full circle */
  isFullCircle: boolean;
  /** Representation identifier */
  repIdentifier: string;
}

/**
 * Collection of symbolic representations from an IFC model
 * These are pre-authored 2D representations for architectural drawings
 */
export interface SymbolicRepresentationCollection {
  /** Number of polylines */
  polylineCount: number;
  /** Number of circles/arcs */
  circleCount: number;
  /** Total count of all symbolic items */
  totalCount: number;
  /** Check if collection is empty */
  isEmpty: boolean;
  /** Get polyline at index */
  getPolyline(index: number): SymbolicPolyline | undefined;
  /** Get circle at index */
  getCircle(index: number): SymbolicCircle | undefined;
  /** Get all express IDs that have symbolic representations */
  getExpressIds(): Uint32Array;
}

/**
 * Converted symbolic data for use in drawing generation
 * Organized by express ID for easy lookup
 */
export interface SymbolicDataByEntity {
  /** Map from expressId to polylines for that entity */
  polylines: Map<number, SymbolicPolyline[]>;
  /** Map from expressId to circles for that entity */
  circles: Map<number, SymbolicCircle[]>;
  /** Set of express IDs that have symbolic representations */
  expressIds: Set<number>;
}
