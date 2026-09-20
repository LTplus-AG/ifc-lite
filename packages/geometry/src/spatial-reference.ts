/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Format-neutral spatial-reference and placement primitives.
 *
 * A source adapter records what its format actually declares in a
 * {@link ModelSpatialReference}.  The resolver only compares those recorded
 * values; it never guesses a CRS from a coordinate magnitude or display name.
 * Geometry stays in its authored frame.  A {@link SpatialPlacement} is a
 * derived f64 transform and may be replaced whenever the federation anchor
 * changes without accumulating a second transform into vertices.
 */

export type SpatialReferenceConfidence = 'verified' | 'declared' | 'assumed' | 'unknown';
export type SpatialAxisDirection = 'east' | 'west' | 'north' | 'south' | 'up' | 'down';

export type SpatialRefusal =
  | 'missing-horizontal-crs'
  | 'crs-mismatch'
  | 'vertical-crs-mismatch'
  | 'vertical-crs-unknown'
  | 'operation-unavailable'
  | 'required-grid-unavailable'
  | 'invalid-axis-or-unit'
  | 'non-invertible-transform'
  | 'manual-placement-required';

/** A canonical CRS identifier supplied by a source adapter, not a display label. */
export interface SpatialCrs {
  /** e.g. `EPSG:2056`; adapters must not populate this by heuristic. */
  readonly id: string;
  /** Source-native authority/code/WKT retained for diagnostics and export. */
  readonly provenance?: Readonly<Record<string, string>>;
}

/** The native source coordinate units and axes before federation placement. */
export interface SourceCoordinateFrame {
  /** Unit scale for source horizontal coordinates, in metres. */
  readonly horizontalUnitToMetres: number;
  /** Unit scale for source elevations, in metres. */
  readonly verticalUnitToMetres: number;
  /** Native source coordinate order/direction, recorded without normalizing it away. */
  readonly axes: readonly [SpatialAxisDirection, SpatialAxisDirection, SpatialAxisDirection];
}

/**
 * A format adapter's local-engineering → projected-map operation.  The
 * operation is deliberately expressed structurally rather than as IFC types;
 * an IFC adapter may fill it from IfcMapConversion, while LandXML or a scan
 * adapter can state a different operation or leave it absent.
 */
export interface LocalProjectedOperation {
  readonly kind: 'local-projected-affine';
  readonly eastings: number;
  readonly northings: number;
  readonly orthogonalHeight: number;
  /** Direction of the source X axis in projected East/North coordinates. */
  readonly xAxisAbscissa: number;
  readonly xAxisOrdinate: number;
  /** Effective per-axis scale from source metres to projected metres. */
  readonly scaleX: number;
  readonly scaleY: number;
  readonly scaleZ: number;
}

export interface ModelSpatialReference {
  readonly source: SourceCoordinateFrame;
  readonly horizontal?: SpatialCrs;
  readonly vertical?: SpatialCrs;
  readonly localToProjected?: LocalProjectedOperation;
  readonly confidence: SpatialReferenceConfidence;
  /** Lossless, source-format-owned metadata; geometry never interprets it. */
  readonly sourceMetadata?: Readonly<Record<string, string | number | boolean>>;
}

/** An affine transform in renderer Y-up metres, evaluated in f64. */
export interface SpatialAffineTransform {
  readonly m00: number; readonly m01: number; readonly m02: number; readonly tx: number;
  readonly m10: number; readonly m11: number; readonly m12: number; readonly ty: number;
  readonly m20: number; readonly m21: number; readonly m22: number; readonly tz: number;
}

export interface SpatialPlacement {
  readonly status: 'same-crs' | 'identity';
  readonly sourceToFederation: SpatialAffineTransform;
  /** Immutable source/target references from which this placement was derived. */
  readonly source: ModelSpatialReference;
  readonly target: ModelSpatialReference;
}

export type SpatialPlacementResult =
  | { ok: true; placement: SpatialPlacement }
  | { ok: false; refusal: SpatialRefusal };

/** Current renderer-frame origin removed from authored viewer coordinates. */
export interface SpatialFrameOffset { readonly x: number; readonly y: number; readonly z: number }

export interface ResolveSpatialPlacementOptions {
  sourceFrameOffset?: SpatialFrameOffset;
  targetFrameOffset?: SpatialFrameOffset;
  /**
   * The default is fail-closed.  Existing formats that genuinely cannot carry
   * a vertical CRS may opt in explicitly while retaining an `assumed` result
   * at their adapter boundary; absence is never silently considered a match.
   */
  unknownVertical?: 'refuse' | 'assume-compatible';
}

const ZERO_OFFSET: SpatialFrameOffset = { x: 0, y: 0, z: 0 };
const EPSILON = 1e-12;

function finite(values: readonly number[]): boolean {
  return values.every(Number.isFinite);
}

function usableFrame(frame: SourceCoordinateFrame): boolean {
  return frame.axes[0] === 'east' && frame.axes[1] === 'up' && frame.axes[2] === 'south'
    && finite([frame.horizontalUnitToMetres, frame.verticalUnitToMetres])
    && Math.abs(frame.horizontalUnitToMetres) >= EPSILON
    && Math.abs(frame.verticalUnitToMetres) >= EPSILON;
}

function normalizedAxis(operation: LocalProjectedOperation): { a: number; b: number } | null {
  const length = Math.hypot(operation.xAxisAbscissa, operation.xAxisOrdinate);
  if (!(Number.isFinite(length) && length >= EPSILON)) return null;
  return { a: operation.xAxisAbscissa / length, b: operation.xAxisOrdinate / length };
}

function usableOperation(operation: LocalProjectedOperation | undefined): operation is LocalProjectedOperation {
  return operation !== undefined
    && operation.kind === 'local-projected-affine'
    && finite([
      operation.eastings, operation.northings, operation.orthogonalHeight,
      operation.xAxisAbscissa, operation.xAxisOrdinate,
      operation.scaleX, operation.scaleY, operation.scaleZ,
    ])
    && Math.abs(operation.scaleX) >= EPSILON
    && Math.abs(operation.scaleY) >= EPSILON
    && Math.abs(operation.scaleZ) >= EPSILON
    && normalizedAxis(operation) !== null;
}

function sameCrs(a: SpatialCrs | undefined, b: SpatialCrs | undefined): boolean {
  return a !== undefined && b !== undefined && a.id === b.id;
}

function verticalCompatible(
  source: ModelSpatialReference,
  target: ModelSpatialReference,
  policy: ResolveSpatialPlacementOptions['unknownVertical'],
): SpatialRefusal | null {
  if (source.vertical && target.vertical) return source.vertical.id === target.vertical.id ? null : 'vertical-crs-mismatch';
  if (policy === 'assume-compatible') return null;
  return 'vertical-crs-unknown';
}

/** Apply a spatial affine transform without narrowing the result. */
export function applySpatialPlacement(
  transform: SpatialAffineTransform,
  x: number,
  y: number,
  z: number,
): readonly [number, number, number] {
  return [
    transform.m00 * x + transform.m01 * y + transform.m02 * z + transform.tx,
    transform.m10 * x + transform.m11 * y + transform.m12 * z + transform.ty,
    transform.m20 * x + transform.m21 * y + transform.m22 * z + transform.tz,
  ];
}

/** Map a renderer Y-up source point to projected East/North/height in f64. */
export function localViewerToProjected(
  reference: ModelSpatialReference,
  point: readonly [number, number, number],
  frameOffset: SpatialFrameOffset = ZERO_OFFSET,
): readonly [number, number, number] | null {
  if (!usableFrame(reference.source) || !usableOperation(reference.localToProjected)
    || !finite([point[0], point[1], point[2], frameOffset.x, frameOffset.y, frameOffset.z])) return null;
  const operation = reference.localToProjected;
  const axis = normalizedAxis(operation);
  if (!axis) return null;
  // Renderer coordinates are East, Up, South. IFC/Y-up geometry's Z is the
  // negated northing, hence the signs are intentionally asymmetric.
  const x = point[0] + frameOffset.x;
  const y = point[1] + frameOffset.y;
  const south = point[2] + frameOffset.z;
  return [
    operation.eastings + operation.scaleX * axis.a * x + operation.scaleY * axis.b * south,
    operation.northings + operation.scaleX * axis.b * x - operation.scaleY * axis.a * south,
    operation.orthogonalHeight + operation.scaleZ * y,
  ];
}

/** Map projected East/North/height to a renderer Y-up source point in f64. */
export function projectedToLocalViewer(
  reference: ModelSpatialReference,
  point: readonly [number, number, number],
  frameOffset: SpatialFrameOffset = ZERO_OFFSET,
): readonly [number, number, number] | null {
  if (!usableFrame(reference.source) || !usableOperation(reference.localToProjected)
    || !finite([point[0], point[1], point[2], frameOffset.x, frameOffset.y, frameOffset.z])) return null;
  const operation = reference.localToProjected;
  const axis = normalizedAxis(operation);
  if (!axis) return null;
  const de = point[0] - operation.eastings;
  const dn = point[1] - operation.northings;
  const x = (axis.a * de + axis.b * dn) / operation.scaleX - frameOffset.x;
  const south = (axis.b * de - axis.a * dn) / operation.scaleY - frameOffset.z;
  const y = (point[2] - operation.orthogonalHeight) / operation.scaleZ - frameOffset.y;
  return finite([x, y, south]) ? [x, y, south] : null;
}

/**
 * Resolve a same-horizontal-CRS source placement into a target's renderer
 * frame. Cross-CRS transforms require an explicit operation provider and are
 * intentionally refused here rather than guessed from matching display names.
 */
export function resolveSpatialPlacement(
  source: ModelSpatialReference,
  target: ModelSpatialReference,
  options: ResolveSpatialPlacementOptions = {},
): SpatialPlacementResult {
  if (!usableFrame(source.source) || !usableFrame(target.source)
    || !usableOperation(source.localToProjected) || !usableOperation(target.localToProjected)) {
    return { ok: false, refusal: 'invalid-axis-or-unit' };
  }
  if (!source.horizontal || !target.horizontal) return { ok: false, refusal: 'missing-horizontal-crs' };
  if (!sameCrs(source.horizontal, target.horizontal)) return { ok: false, refusal: 'crs-mismatch' };
  const vertical = verticalCompatible(source, target, options.unknownVertical ?? 'refuse');
  if (vertical) return { ok: false, refusal: vertical };

  const sourceOperation = source.localToProjected;
  const targetOperation = target.localToProjected;
  const sourceAxis = normalizedAxis(sourceOperation)!;
  const targetAxis = normalizedAxis(targetOperation)!;
  const targetOffset = options.targetFrameOffset ?? ZERO_OFFSET;
  const sourceOffset = options.sourceFrameOffset ?? ZERO_OFFSET;
  if (!finite([
    sourceOffset.x, sourceOffset.y, sourceOffset.z,
    targetOffset.x, targetOffset.y, targetOffset.z,
  ])) return { ok: false, refusal: 'invalid-axis-or-unit' };

  // Derive columns from the public f64 map/inverse functions. This retains the
  // deliberately asymmetric South axis and makes the transform independently
  // checkable against point conversion without duplicating formulae.
  const origin = localViewerToProjected(source, [0, 0, 0], sourceOffset);
  const x = localViewerToProjected(source, [1, 0, 0], sourceOffset);
  const y = localViewerToProjected(source, [0, 1, 0], sourceOffset);
  const z = localViewerToProjected(source, [0, 0, 1], sourceOffset);
  if (!origin || !x || !y || !z) return { ok: false, refusal: 'non-invertible-transform' };
  const p0 = projectedToLocalViewer(target, origin, targetOffset);
  const px = projectedToLocalViewer(target, x, targetOffset);
  const py = projectedToLocalViewer(target, y, targetOffset);
  const pz = projectedToLocalViewer(target, z, targetOffset);
  if (!p0 || !px || !py || !pz) return { ok: false, refusal: 'non-invertible-transform' };
  const transform: SpatialAffineTransform = {
    m00: px[0] - p0[0], m01: py[0] - p0[0], m02: pz[0] - p0[0], tx: p0[0],
    m10: px[1] - p0[1], m11: py[1] - p0[1], m12: pz[1] - p0[1], ty: p0[1],
    m20: px[2] - p0[2], m21: py[2] - p0[2], m22: pz[2] - p0[2], tz: p0[2],
  };
  if (!finite(Object.values(transform))) return { ok: false, refusal: 'non-invertible-transform' };
  const identity = Math.abs(transform.m00 - 1) < 1e-12 && Math.abs(transform.m11 - 1) < 1e-12
    && Math.abs(transform.m22 - 1) < 1e-12 && Math.abs(transform.m01) < 1e-12
    && Math.abs(transform.m02) < 1e-12 && Math.abs(transform.m10) < 1e-12
    && Math.abs(transform.m12) < 1e-12 && Math.abs(transform.m20) < 1e-12
    && Math.abs(transform.m21) < 1e-12 && Math.abs(transform.tx) < 1e-12
    && Math.abs(transform.ty) < 1e-12 && Math.abs(transform.tz) < 1e-12;
  return { ok: true, placement: { status: identity ? 'identity' : 'same-crs', sourceToFederation: transform, source, target } };
}
