/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DXF import types (issue #1782).
 *
 * Two layers of model:
 * - the raw parsed document (`DxfDocument` + `DxfEntity` variants), a direct
 *   reading of the group-code stream, still in DXF drawing units, and
 * - the converted reference underlay (`DxfUnderlay`), tessellated into the
 *   drawing-2d Point2D/Polygon2D vocabulary in WORLD plan coordinates:
 *   metres, IFC XY (+Y = north). DXF and IFC are both Z-up, so no axis
 *   swap happens here; consumers map world → drawing space themselves
 *   (plan drawing space is `(x, -y)` plus any render-frame origin shift).
 */

import type { Point2D, Polygon2D, Bounds2D } from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════
// RAW GROUP-CODE MODEL
// ═══════════════════════════════════════════════════════════════════════════

/** One group-code/value pair from an ASCII DXF file. */
export interface DxfPair {
  code: number;
  value: string;
}

/** Fields shared by every parsed DXF entity. */
export interface DxfEntityCommon {
  /** Layer name (group 8); DXF defaults to layer "0". */
  layer: string;
  /** ACI colour number (group 62): 0 = BYBLOCK, 256 = BYLAYER. */
  colorNumber: number;
  /** 24-bit true colour (group 420); overrides `colorNumber` when present. */
  trueColor?: number;
  /** Linetype name (group 6); anything non-continuous renders dashed. */
  linetype?: string;
  /** Lineweight in mm (group 370 is 1/100 mm); undefined = BYLAYER/default. */
  lineweightMm?: number;
  /** Entity invisibility flag (group 60). */
  invisible: boolean;
  /**
   * Z component of the OCS extrusion direction (group 230). Planar entities
   * with extrusion (0,0,-1) have their X axis mirrored; other tilted
   * extrusions are rare in 2D drawings and are treated as +Z.
   */
  extrusionZ: number;
}

/** Polyline vertex; `bulge` is tan(sweep/4) of the arc to the next vertex. */
export interface DxfVertex {
  x: number;
  y: number;
  bulge: number;
}

export interface DxfLineEntity extends DxfEntityCommon {
  kind: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** LWPOLYLINE and classic POLYLINE/VERTEX chains, unified. */
export interface DxfPolylineEntity extends DxfEntityCommon {
  kind: 'polyline';
  vertices: DxfVertex[];
  closed: boolean;
}

export interface DxfCircleEntity extends DxfEntityCommon {
  kind: 'circle';
  cx: number;
  cy: number;
  r: number;
}

export interface DxfArcEntity extends DxfEntityCommon {
  kind: 'arc';
  cx: number;
  cy: number;
  r: number;
  /** Start/end angles in degrees, counter-clockwise from +X. */
  startDeg: number;
  endDeg: number;
}

export interface DxfEllipseEntity extends DxfEntityCommon {
  kind: 'ellipse';
  cx: number;
  cy: number;
  /** Endpoint of the major axis relative to the centre. */
  majorX: number;
  majorY: number;
  /** Minor-to-major axis ratio. */
  ratio: number;
  /** Start/end parameters in radians (0..2π = full ellipse). */
  startParam: number;
  endParam: number;
}

export interface DxfTextEntity extends DxfEntityCommon {
  kind: 'text';
  x: number;
  y: number;
  /** Text height in DXF drawing units. */
  height: number;
  /** Rotation in degrees, counter-clockwise. */
  rotationDeg: number;
  text: string;
  hAlign: 'left' | 'center' | 'right';
  vAlign: 'baseline' | 'bottom' | 'middle' | 'top';
}

/** SPLINE entity: clamped B-spline control net (or fit points). */
export interface DxfSplineEntity extends DxfEntityCommon {
  kind: 'spline';
  degree: number;
  closed: boolean;
  knots: number[];
  controlPoints: Array<{ x: number; y: number }>;
  fitPoints: Array<{ x: number; y: number }>;
}

/** SOLID/TRACE entity: a filled triangle or quad. Corners in draw order. */
export interface DxfSolidEntity extends DxfEntityCommon {
  kind: 'solid';
  corners: Array<{ x: number; y: number }>;
}

export interface DxfInsertEntity extends DxfEntityCommon {
  kind: 'insert';
  blockName: string;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotationDeg: number;
  columnCount: number;
  rowCount: number;
  columnSpacing: number;
  rowSpacing: number;
}

/**
 * DIMENSION entities carry a pre-rendered anonymous block (`*D…`, group 2)
 * with the dimension's lines, arrows, and text in WCS coordinates; importing
 * renders that block rather than re-deriving dimension geometry.
 */
export interface DxfDimensionEntity extends DxfEntityCommon {
  kind: 'dimension';
  blockName: string;
}

/** One HATCH boundary path, tessellated to a vertex loop at parse time. */
export interface DxfHatchPath {
  vertices: DxfVertex[];
}

export interface DxfHatchEntity extends DxfEntityCommon {
  kind: 'hatch';
  /** True for SOLID fills (group 70 = 1); pattern hatches render translucent. */
  solid: boolean;
  paths: DxfHatchPath[];
}

export type DxfEntity =
  | DxfLineEntity
  | DxfPolylineEntity
  | DxfCircleEntity
  | DxfArcEntity
  | DxfEllipseEntity
  | DxfTextEntity
  | DxfSplineEntity
  | DxfSolidEntity
  | DxfInsertEntity
  | DxfDimensionEntity
  | DxfHatchEntity;

/** LAYER table record. */
export interface DxfLayerInfo {
  name: string;
  /** ACI colour number (absolute value of group 62). */
  colorNumber: number;
  /** 24-bit true colour (group 420); wins over `colorNumber` when present. */
  trueColor?: number;
  /** False when the layer is off (negative group 62) or frozen (70 bit 1). */
  visible: boolean;
  linetype?: string;
  /** Default lineweight in mm (group 370, 1/100 mm), if set. */
  lineweightMm?: number;
}

/** BLOCK definition. */
export interface DxfBlockInfo {
  name: string;
  baseX: number;
  baseY: number;
  entities: DxfEntity[];
}

/** Parsed DXF document (drawing units, unscaled). */
export interface DxfDocument {
  /** $INSUNITS header value (0 = unitless / absent). */
  insunits: number;
  layers: Map<string, DxfLayerInfo>;
  blocks: Map<string, DxfBlockInfo>;
  entities: DxfEntity[];
  /** Entity types encountered but not supported, with occurrence counts. */
  skipped: Record<string, number>;
  warnings: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// CONVERTED UNDERLAY MODEL (world plan coordinates: metres, +Y = north)
// ═══════════════════════════════════════════════════════════════════════════

/** Stroked path (already tessellated; arcs/circles become segments). */
export interface DxfUnderlayPath {
  points: Point2D[];
  closed: boolean;
  /** CSS colour; set only when the entity overrides its layer colour. */
  color?: string;
  /** True when the entity's linetype is not continuous. */
  dashed?: boolean;
  /** Lineweight in mm on paper (entity or layer group 370), if set. */
  widthMm?: number;
}

/** Filled region from a HATCH. */
export interface DxfUnderlayFill {
  polygon: Polygon2D;
  color?: string;
  /** True for pattern (non-SOLID) hatches, rendered translucent. */
  pattern: boolean;
}

/** Text label. Position and direction are in world plan coordinates. */
export interface DxfUnderlayText {
  position: Point2D;
  text: string;
  /** Cap height in metres. */
  height: number;
  /** Baseline direction in world space (unit vector; +Y = north). */
  dirX: number;
  dirY: number;
  align: 'left' | 'center' | 'right';
  valign: 'baseline' | 'bottom' | 'middle' | 'top';
  color?: string;
}

/** All converted content of one DXF layer. */
export interface DxfUnderlayLayer {
  name: string;
  /** Default CSS colour for entities on this layer. */
  color: string;
  /** Initial visibility from the DXF layer table (off/frozen start hidden). */
  visible: boolean;
  paths: DxfUnderlayPath[];
  fills: DxfUnderlayFill[];
  texts: DxfUnderlayText[];
}

/**
 * A DXF file converted to a 2D reference underlay. Geometry is in world
 * plan coordinates: metres, IFC XY, +Y = north (DXF and IFC are both
 * Z-up). Mapping to a concrete drawing view (y-flip, render-frame origin
 * shift, flipped-section mirror) is the consumer's job.
 */
export interface DxfUnderlay {
  name: string;
  layers: DxfUnderlayLayer[];
  bounds: Bounds2D;
  /** DXF drawing units → metres factor derived from $INSUNITS. */
  unitScale: number;
  /** Entity types skipped during import, with counts. */
  skipped: Record<string, number>;
  warnings: string[];
}

/** User placement of an underlay in drawing space. */
export interface DxfPlacement {
  /** Offset in metres (drawing space). */
  offsetX: number;
  offsetY: number;
  /** Rotation in degrees, counter-clockwise as seen on a plan view. */
  rotationDeg: number;
  /** Uniform scale multiplier on top of the unit conversion. */
  scale: number;
}

export const DEFAULT_DXF_PLACEMENT: DxfPlacement = {
  offsetX: 0,
  offsetY: 0,
  rotationDeg: 0,
  scale: 1,
};
