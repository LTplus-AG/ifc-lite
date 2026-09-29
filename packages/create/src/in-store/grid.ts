/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for a design grid (#6232): an IfcGrid contained in the
 * storey with tagged IfcGridAxis U and V axes (and optionally W), plus
 * `gridIntersectionPlacement`, the IfcGridPlacement an element needs to sit
 * on a grid intersection.
 *
 * Axes are straight lines given in the grid's own frame (metres, XY): the
 * grid is placed on the storey at `Position`, turned by `Direction` about Z.
 * Each axis curve is a two-point IfcPolyline, and the grid's 'FootPrint'
 * representation is an IfcGeometricCurveSet of those same curves, so a viewer
 * that reads either the axes or the representation draws the same lines.
 * `rectangularGridAxes` makes the usual numbered / lettered orthogonal grid.
 *
 * Schema gating (D2): attributes are laid out from the anchor schema's
 * registry. `IfcGrid.PredefinedType` exists from IFC4 on (dropped on IFC2X3);
 * IFC4X3's IfcGridPlacement carries `PlacementRelTo` (the grid's placement),
 * IFC2X3/IFC4 place it implicitly in the grid's frame; IFC2X3 orients a grid
 * placement only by a second intersection, not a direction; IFC5 is refused.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import { assertFinitePoint3 } from '../ifc-creator-math.js';
import { toNativeLength, toNativePoint3, type SpatialAnchor } from './anchor.js';
import {
  emitLocalPlacement,
  emitRelContainedInSpatialStructure,
  ownerHistoryRef,
  productGuid,
} from './_emit-helpers.js';
import { schemaAttributes, schemaRegistry } from './schema-attributes.js';

type Attrs = Parameters<StoreEditor['addEntity']>[1];
type Vec2 = [number, number];

export interface GridAxisInStoreParams {
  /** The axis tag shown in its bubble ('1', 'A', ...). Unique within the grid. */
  Tag: string;
  /** Start of the axis line in the grid's frame (metres). */
  Start: Vec2;
  /** End of the axis line in the grid's frame (metres). */
  End: Vec2;
}

export interface GridInStoreParams {
  /** Grid origin, storey-local (metres). Default [0, 0, 0]. */
  Position?: [number, number, number];
  /** Rotation of the grid about Z, radians (0 = grid X along storey X). Default 0. */
  Direction?: number;
  /** At least one axis. */
  UAxes: readonly GridAxisInStoreParams[];
  /** At least one axis. */
  VAxes: readonly GridAxisInStoreParams[];
  /** Optional third family (triangular grids). */
  WAxes?: readonly GridAxisInStoreParams[];
  /** IfcGrid PredefinedType (IFC4+; dropped on IFC2X3). */
  PredefinedType?: 'RECTANGULAR' | 'RADIAL' | 'TRIANGULAR' | 'IRREGULAR' | 'USERDEFINED' | 'NOTDEFINED';
  Name?: string;
  Description?: string;
  ObjectType?: string;
  /** Explicit GlobalId (22-char IFC GUID); generated when omitted. */
  GlobalId?: string;
}

export interface GridBuildResult {
  gridId: number;
  placementId: number;
  /** IfcGridAxis ids, in `UAxes` order. */
  uAxisIds: number[];
  /** IfcGridAxis ids, in `VAxes` order. */
  vAxisIds: number[];
  /** IfcGridAxis ids, in `WAxes` order (empty without W axes). */
  wAxisIds: number[];
  shapeRepId: number;
  productShapeId: number;
  relContainedId: number;
}

/** Spreadsheet-style letters: 0 -> A, 25 -> Z, 26 -> AA. */
function letters(index: number): string {
  let out = '';
  for (let i = index + 1; i > 0; i = Math.floor((i - 1) / 26)) out = String.fromCharCode(65 + ((i - 1) % 26)) + out;
  return out;
}

/**
 * U and V axes of an orthogonal grid, in the grid's frame (metres): U axes are
 * the lines x = each of `UOffsets` (tagged 1, 2, 3, ...), V axes the lines
 * y = each of `VOffsets` (tagged A, B, C, ...). Every axis runs `Overhang`
 * (default 1 m) past the outermost crossing axes.
 */
export function rectangularGridAxes(options: {
  UOffsets: readonly number[];
  VOffsets: readonly number[];
  UTags?: readonly string[];
  VTags?: readonly string[];
  Overhang?: number;
}): { UAxes: GridAxisInStoreParams[]; VAxes: GridAxisInStoreParams[] } {
  const op = 'rectangularGridAxes';
  const { UOffsets, VOffsets } = options;
  for (const [name, offsets] of [['UOffsets', UOffsets], ['VOffsets', VOffsets]] as const) {
    if (!Array.isArray(offsets) || offsets.length === 0 || offsets.some((v) => !Number.isFinite(v))) {
      throw new Error(`${op}: ${name} must be a non-empty array of finite numbers`);
    }
  }
  const overhang = options.Overhang ?? 1;
  if (!Number.isFinite(overhang) || overhang < 0) throw new Error(`${op}: Overhang must be a finite, non-negative number`);
  const x0 = Math.min(...UOffsets) - overhang;
  const x1 = Math.max(...UOffsets) + overhang;
  const y0 = Math.min(...VOffsets) - overhang;
  const y1 = Math.max(...VOffsets) + overhang;
  return {
    UAxes: UOffsets.map((x, i) => ({ Tag: options.UTags?.[i] ?? String(i + 1), Start: [x, y0], End: [x, y1] })),
    VAxes: VOffsets.map((y, i) => ({ Tag: options.VTags?.[i] ?? letters(i), Start: [x0, y], End: [x1, y] })),
  };
}

function assertGridParams(params: GridInStoreParams, op: string): void {
  if (params.Position !== undefined) assertFinitePoint3({ Position: params.Position }, op);
  if (params.Direction !== undefined && !Number.isFinite(params.Direction)) {
    throw new Error(`${op}: Direction must be a finite number (radians)`);
  }
  const tags = new Set<string>();
  const families: Array<[string, readonly GridAxisInStoreParams[] | undefined, boolean]> = [
    ['UAxes', params.UAxes, true],
    ['VAxes', params.VAxes, true],
    ['WAxes', params.WAxes, false],
  ];
  for (const [name, axes, required] of families) {
    if (axes === undefined && !required) continue;
    if (!Array.isArray(axes) || (required && axes.length === 0)) {
      throw new Error(`${op}: ${name} needs at least one axis`);
    }
    axes.forEach((axis, i) => {
      if (typeof axis?.Tag !== 'string' || axis.Tag.trim() === '') throw new Error(`${op}: ${name}[${i}].Tag must be a non-empty string`);
      if (tags.has(axis.Tag)) throw new Error(`${op}: axis tag "${axis.Tag}" is used twice`);
      tags.add(axis.Tag);
      const points = [axis.Start, axis.End];
      if (points.some((p) => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) {
        throw new Error(`${op}: ${name}[${i}] Start and End must be finite [x, y] points`);
      }
      if (Math.hypot(axis.End[0] - axis.Start[0], axis.End[1] - axis.Start[1]) <= 1e-9) {
        throw new Error(`${op}: ${name}[${i}] Start and End must be distinct points`);
      }
    });
  }
}

export function addGridToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: GridInStoreParams,
): GridBuildResult {
  const op = 'addGridToStore';
  assertGridParams(params, op);
  const registry = schemaRegistry(anchor.schema, op);
  const isIfc2x3 = registry.name.toUpperCase() === 'IFC2X3';
  const globalId = productGuid(params, anchor.guidRandom);
  const gridValues = (placement: string | null, shape: string | null, u: string[], v: string[], w: string[]) => ({
    GlobalId: globalId,
    OwnerHistory: ownerHistoryRef(anchor.ownerHistoryId),
    Name: params.Name ?? 'Grid',
    Description: params.Description,
    ObjectType: params.ObjectType,
    ObjectPlacement: placement,
    Representation: shape,
    UAxes: u,
    VAxes: v,
    WAxes: w.length > 0 ? w : null,
    ...(isIfc2x3 ? {} : { PredefinedType: params.PredefinedType }),
  });
  // Lay the grid record out before the first emit so a bad PredefinedType or
  // a missing IFC2X3 OwnerHistory refuses cleanly.
  schemaAttributes(registry, 'IfcGrid', gridValues(null, null, ['#0'], ['#0'], []), op);

  const direction = params.Direction ?? 0;
  const placementId = emitLocalPlacement(
    editor,
    anchor.storeyPlacementId,
    toNativePoint3(anchor, params.Position ?? [0, 0, 0]),
    [0, 0, 1],
    [Math.cos(direction), Math.sin(direction), 0],
  );

  const curves: number[] = [];
  const emitAxes = (axes: readonly GridAxisInStoreParams[] | undefined) => (axes ?? []).map((axis) => {
    const points = [axis.Start, axis.End].map((p) => editor.addEntity('IfcCartesianPoint', [
      [toNativeLength(anchor, p[0]), toNativeLength(anchor, p[1])],
    ]).expressId);
    const curve = editor.addEntity('IfcPolyline', [points.map((id) => `#${id}`)]).expressId;
    curves.push(curve);
    return editor.addEntity('IfcGridAxis', schemaAttributes(registry, 'IfcGridAxis', {
      AxisTag: axis.Tag,
      AxisCurve: `#${curve}`,
      SameSense: true,
    }, op) as Attrs).expressId;
  });
  const uAxisIds = emitAxes(params.UAxes);
  const vAxisIds = emitAxes(params.VAxes);
  const wAxisIds = emitAxes(params.WAxes);

  // 'FootPrint' GeometricCurveSet of the axis curves, in the root 3D context
  // (models rarely carry a FootPrint subcontext).
  const curveSet = editor.addEntity('IfcGeometricCurveSet', [curves.map((id) => `#${id}`)]).expressId;
  const shapeRepId = editor.addEntity('IfcShapeRepresentation', [
    `#${anchor.rootContextId ?? anchor.axisContextId}`,
    'FootPrint',
    'GeometricCurveSet',
    [`#${curveSet}`],
  ]).expressId;
  const productShapeId = editor.addEntity('IfcProductDefinitionShape', [null, null, [`#${shapeRepId}`]]).expressId;

  const refs = (ids: number[]) => ids.map((id) => `#${id}`);
  const gridId = editor.addEntity('IfcGrid', schemaAttributes(
    registry,
    'IfcGrid',
    gridValues(`#${placementId}`, `#${productShapeId}`, refs(uAxisIds), refs(vAxisIds), refs(wAxisIds)),
    op,
  ) as Attrs).expressId;
  const relContainedId = emitRelContainedInSpatialStructure(
    editor, anchor.ownerHistoryId, gridId, anchor.storeyId, anchor.guidRandom,
  );

  return { gridId, placementId, uAxisIds, vAxisIds, wAxisIds, shapeRepId, productShapeId, relContainedId };
}

/** Two grid axes (IfcGridAxis ids) and optional offsets from them (metres). */
export interface GridIntersectionParams {
  /** The two crossing axes, e.g. a U axis and a V axis of the same grid. */
  Axes: readonly [number, number];
  /**
   * Offsets (metres): the distance of the point from the first and from the
   * second axis, measured perpendicular to each (to its left, looking along
   * the axis), and an optional height above the grid plane. Default [0, 0].
   */
  Offsets?: readonly [number, number] | readonly [number, number, number];
}

export interface GridPlacementParams extends GridIntersectionParams {
  /**
   * Local +X of the placed element: a direction in the grid plane ([x, y]),
   * or a second intersection it points at. Default: the grid's X axis.
   * IFC2X3 accepts only an intersection.
   */
  RefDirection?: readonly [number, number] | GridIntersectionParams;
  /**
   * The grid's ObjectPlacement (`GridBuildResult.placementId`). Written as
   * `PlacementRelTo` on IFC4X3; IFC2X3/IFC4 have no such attribute, their grid
   * placement is implicitly in the frame of the grid the axes belong to.
   */
  GridPlacementId?: number;
}

export interface GridPlacementResult {
  placementId: number;
  intersectionId: number;
  /** The IfcDirection or second IfcVirtualGridIntersection, when a RefDirection was given. */
  refDirectionId: number | null;
}

function assertIntersection(editor: StoreEditor, params: GridIntersectionParams, name: string, op: string): void {
  if (!Array.isArray(params?.Axes) || params.Axes.length !== 2 || params.Axes[0] === params.Axes[1]) {
    throw new Error(`${op}: ${name}.Axes must be two different IfcGridAxis ids`);
  }
  for (const id of params.Axes) {
    const type = editor.getEntityType(id);
    if (type !== 'IfcGridAxis') throw new Error(`${op}: #${id} is ${type ?? 'not an entity'}, not an IfcGridAxis`);
  }
  const offsets = params.Offsets;
  if (offsets !== undefined && (!Array.isArray(offsets) || offsets.length < 2 || offsets.length > 3 || !offsets.every(Number.isFinite))) {
    throw new Error(`${op}: ${name}.Offsets must be two or three finite numbers`);
  }
}

/**
 * Emit an IfcGridPlacement on the intersection of two grid axes, for an
 * element's `ObjectPlacement` (IfcProduct attribute 5). The element's own
 * geometry is then relative to the intersection, oriented by `RefDirection`.
 */
export function gridIntersectionPlacement(
  editor: StoreEditor,
  anchor: Pick<SpatialAnchor, 'schema' | 'lengthUnitScale'>,
  params: GridPlacementParams,
): GridPlacementResult {
  const op = 'gridIntersectionPlacement';
  const registry = schemaRegistry(anchor.schema, op);
  const isIfc2x3 = registry.name.toUpperCase() === 'IFC2X3';
  const isIfc4x3 = registry.name.toUpperCase().startsWith('IFC4X3');
  assertIntersection(editor, params, 'Location', op);
  const ref = params.RefDirection;
  const refIsVector = Array.isArray(ref);
  if (ref !== undefined) {
    if (refIsVector) {
      const [x, y] = ref as readonly number[];
      if (ref.length !== 2 || !Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(x, y) <= 1e-12) {
        throw new Error(`${op}: RefDirection must be a non-zero finite [x, y] direction`);
      }
      if (isIfc2x3) throw new Error(`${op}: IFC2X3 orients a grid placement only by a second intersection, not a direction`);
    } else {
      assertIntersection(editor, ref as GridIntersectionParams, 'RefDirection', op);
    }
  }
  if (params.GridPlacementId !== undefined && isIfc4x3) {
    const type = editor.getEntityType(params.GridPlacementId);
    if (type === undefined || !/Placement$/.test(type)) {
      throw new Error(`${op}: GridPlacementId #${params.GridPlacementId} is ${type ?? 'not an entity'}, not an object placement`);
    }
  }

  const emitIntersection = (p: GridIntersectionParams) => editor.addEntity('IfcVirtualGridIntersection', schemaAttributes(
    registry,
    'IfcVirtualGridIntersection',
    {
      IntersectingAxes: p.Axes.map((id) => `#${id}`),
      OffsetDistances: (p.Offsets ?? [0, 0]).map((d) => ({ real: toNativeLength(anchor, d) })),
    },
    op,
  ) as Attrs).expressId;

  const intersectionId = emitIntersection(params);
  let refDirectionId: number | null = null;
  if (ref !== undefined) {
    refDirectionId = refIsVector
      ? editor.addEntity('IfcDirection', [[(ref as readonly number[])[0], (ref as readonly number[])[1], 0]]).expressId
      : emitIntersection(ref as GridIntersectionParams);
  }
  const placementId = editor.addEntity('IfcGridPlacement', schemaAttributes(registry, 'IfcGridPlacement', {
    ...(isIfc4x3 && params.GridPlacementId !== undefined ? { PlacementRelTo: `#${params.GridPlacementId}` } : {}),
    PlacementLocation: `#${intersectionId}`,
    PlacementRefDirection: refDirectionId === null ? null : `#${refDirectionId}`,
  }, op) as Attrs).expressId;

  return { placementId, intersectionId, refDirectionId };
}
