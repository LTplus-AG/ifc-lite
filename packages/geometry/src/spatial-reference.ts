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

/** Current source-frame origin removed from authored source coordinates. */
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
  const horizontal = new Set(frame.axes.filter((axis) => axis !== 'up' && axis !== 'down'));
  const vertical = frame.axes.filter((axis) => axis === 'up' || axis === 'down');
  const hasEastWest = [...horizontal].some((axis) => axis === 'east' || axis === 'west');
  const hasNorthSouth = [...horizontal].some((axis) => axis === 'north' || axis === 'south');
  return horizontal.size === 2 && hasEastWest && hasNorthSouth && vertical.length === 1
    && finite([frame.horizontalUnitToMetres, frame.verticalUnitToMetres])
    // Direction belongs exclusively in `axes`; a unit-to-metre factor cannot
    // be negative without silently reflecting a source a second time.
    && frame.horizontalUnitToMetres >= EPSILON
    && frame.verticalUnitToMetres >= EPSILON;
}

/** Convert a source-native point to the renderer's East/Up/South metre frame. */
function sourceToViewer(
  frame: SourceCoordinateFrame,
  point: readonly [number, number, number],
): readonly [number, number, number] | null {
  if (!usableFrame(frame) || !finite(point)) return null;
  let east: number | undefined;
  let up: number | undefined;
  let south: number | undefined;
  for (let index = 0; index < 3; index++) {
    const axis = frame.axes[index];
    const value = point[index];
    switch (axis) {
      case 'east': east = value * frame.horizontalUnitToMetres; break;
      case 'west': east = -value * frame.horizontalUnitToMetres; break;
      case 'up': up = value * frame.verticalUnitToMetres; break;
      case 'down': up = -value * frame.verticalUnitToMetres; break;
      case 'south': south = value * frame.horizontalUnitToMetres; break;
      case 'north': south = -value * frame.horizontalUnitToMetres; break;
    }
  }
  return east === undefined || up === undefined || south === undefined ? null : [east, up, south];
}

/** Convert a renderer East/Up/South metre point to source-native coordinates. */
function viewerToSource(
  frame: SourceCoordinateFrame,
  point: readonly [number, number, number],
): readonly [number, number, number] | null {
  if (!usableFrame(frame) || !finite(point)) return null;
  const values = frame.axes.map((axis) => {
    switch (axis) {
      case 'east': return point[0] / frame.horizontalUnitToMetres;
      case 'west': return -point[0] / frame.horizontalUnitToMetres;
      case 'up': return point[1] / frame.verticalUnitToMetres;
      case 'down': return -point[1] / frame.verticalUnitToMetres;
      case 'south': return point[2] / frame.horizontalUnitToMetres;
      case 'north': return -point[2] / frame.horizontalUnitToMetres;
    }
  });
  return finite(values) ? [values[0], values[1], values[2]] : null;
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

/** Map a source-native point to projected East/North/height in f64. */
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
  const viewer = sourceToViewer(reference.source, point);
  const viewerOffset = sourceToViewer(reference.source, [frameOffset.x, frameOffset.y, frameOffset.z]);
  if (!viewer || !viewerOffset) return null;
  const x = viewer[0] + viewerOffset[0];
  const y = viewer[1] + viewerOffset[1];
  const south = viewer[2] + viewerOffset[2];
  return [
    operation.eastings + operation.scaleX * axis.a * x + operation.scaleY * axis.b * south,
    operation.northings + operation.scaleX * axis.b * x - operation.scaleY * axis.a * south,
    operation.orthogonalHeight + operation.scaleZ * y,
  ];
}

/** Map projected East/North/height to a source-native point in f64. */
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
  const x = (axis.a * de + axis.b * dn) / operation.scaleX;
  const south = (axis.b * de - axis.a * dn) / operation.scaleY;
  const y = (point[2] - operation.orthogonalHeight) / operation.scaleZ;
  const source = viewerToSource(reference.source, [x, y, south]);
  if (!source) return null;
  // Frame offsets live in the reference's NATIVE source coordinates, just as
  // the point this function returns does. Treating the offset as viewer axes
  // and converting it a second time happened to work for IFC's viewer-shaped
  // metre frame, but corrupts a feet/North-East-Down adapter's inverse.
  const result: readonly [number, number, number] = [
    source[0] - frameOffset.x, source[1] - frameOffset.y, source[2] - frameOffset.z,
  ];
  return finite(result) ? result : null;
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

  // The origin goes through the public f64 map/inverse functions because it
  // contains both map and frame offsets. The linear columns must NOT be
  // derived by subtracting two ~million-metre projected points: that loses
  // meaningful sub-millimetre precision before the target inverse sees them.
  // Compose just the linear map terms below, then convert the target viewer
  // deltas back to its native axes/units. This retains the deliberately
  // asymmetric South axis without finite-differencing large coordinates.
  const origin = localViewerToProjected(source, [0, 0, 0], sourceOffset);
  if (!origin) return { ok: false, refusal: 'non-invertible-transform' };
  const p0 = projectedToLocalViewer(target, origin, targetOffset);
  if (!p0) return { ok: false, refusal: 'non-invertible-transform' };

  const sourceToTargetDelta = (sourceNative: readonly [number, number, number]): readonly [number, number, number] | null => {
    const sourceViewer = sourceToViewer(source.source, sourceNative);
    if (!sourceViewer) return null;
    const [east, up, south] = sourceViewer;
    const deltaEast = sourceOperation.scaleX * sourceAxis.a * east + sourceOperation.scaleY * sourceAxis.b * south;
    const deltaNorth = sourceOperation.scaleX * sourceAxis.b * east - sourceOperation.scaleY * sourceAxis.a * south;
    const deltaHeight = sourceOperation.scaleZ * up;
    const targetViewer: readonly [number, number, number] = [
      (targetAxis.a * deltaEast + targetAxis.b * deltaNorth) / targetOperation.scaleX,
      deltaHeight / targetOperation.scaleZ,
      (targetAxis.b * deltaEast - targetAxis.a * deltaNorth) / targetOperation.scaleY,
    ];
    return viewerToSource(target.source, targetViewer);
  };
  const px = sourceToTargetDelta([1, 0, 0]);
  const py = sourceToTargetDelta([0, 1, 0]);
  const pz = sourceToTargetDelta([0, 0, 1]);
  if (!px || !py || !pz) return { ok: false, refusal: 'non-invertible-transform' };
  const transform: SpatialAffineTransform = {
    m00: px[0], m01: py[0], m02: pz[0], tx: p0[0],
    m10: px[1], m11: py[1], m12: pz[1], ty: p0[1],
    m20: px[2], m21: py[2], m22: pz[2], tz: p0[2],
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
