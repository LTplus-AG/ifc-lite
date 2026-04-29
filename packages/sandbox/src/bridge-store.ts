/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridge schema — bim.store namespace methods.
 *
 * Exposes document-level edits (`addEntity`, `removeEntity`,
 * `setPositionalAttribute`) into the QuickJS sandbox.
 */

import type { NamespaceSchema } from './bridge-schema.js';
import { toRef } from './bridge-helpers.js';

export function buildStoreNamespace(): NamespaceSchema {
  return {
    name: 'store',
    doc: 'Document-level edits — add, remove, and edit positional STEP arguments on entities of a parsed model',
    permission: 'store',
    methods: [
      {
        name: 'addEntity',
        doc: 'Inject a new entity into the active model. Returns an EntityRef for the freshly-allocated expressId.',
        args: ['string', 'dump'],
        paramNames: ['modelId', 'def'],
        tsParamTypes: [
          'string',
          '{ type: string; attributes: unknown[] }',
        ],
        tsReturn: '{ modelId: string; expressId: number }',
        call: (sdk, args) => {
          const def = args[1] as { type: string; attributes: unknown[] };
          if (!def || typeof def.type !== 'string' || !Array.isArray(def.attributes)) {
            throw new Error('bim.store.addEntity: def must be { type: string, attributes: unknown[] }');
          }
          return sdk.store.addEntity(args[0] as string, def);
        },
        returns: 'value',
      },
      {
        name: 'removeEntity',
        doc: 'Remove an entity. Tombstones existing entities; forgets overlay-only ones. Returns false if the id is unknown.',
        args: ['dump'],
        paramNames: ['entity'],
        tsParamTypes: ['{ modelId: string; expressId: number }'],
        tsReturn: 'boolean',
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) {
            throw new Error('bim.store.removeEntity: invalid entity reference');
          }
          return sdk.store.removeEntity(ref);
        },
        returns: 'value',
      },
      {
        name: 'setPositionalAttribute',
        doc: 'Edit a non-IfcRoot attribute by zero-based STEP argument index (e.g. IfcRectangleProfileDef.XDim is index 3).',
        args: ['dump', 'number', 'dump'],
        paramNames: ['entity', 'index', 'value'],
        tsParamTypes: [
          '{ modelId: string; expressId: number }',
          'number',
          'unknown',
        ],
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) {
            throw new Error('bim.store.setPositionalAttribute: invalid entity reference');
          }
          const index = args[1] as number;
          if (!Number.isInteger(index) || index < 0) {
            throw new Error(`bim.store.setPositionalAttribute: index must be a non-negative integer, got ${index}`);
          }
          sdk.store.setPositionalAttribute(ref, index, args[2]);
        },
        returns: 'void',
      },
      {
        name: 'addColumn',
        doc: 'Add an IfcColumn to a parsed model anchored to an existing IfcBuildingStorey. Returns the new column entity ref.',
        args: ['string', 'number', 'dump'],
        paramNames: ['modelId', 'storeyExpressId', 'params'],
        tsParamTypes: [
          'string',
          'number',
          '{ Position: [number, number, number]; Width: number; Depth: number; Height: number; Name?: string; Description?: string; ObjectType?: string; Tag?: string }',
        ],
        tsReturn: '{ modelId: string; expressId: number }',
        call: (sdk, args) => {
          const storeyExpressId = args[1] as number;
          if (!Number.isInteger(storeyExpressId) || storeyExpressId < 0) {
            throw new Error(`bim.store.addColumn: storeyExpressId must be a non-negative integer, got ${storeyExpressId}`);
          }
          const params = args[2] as Parameters<typeof sdk.store.addColumn>[2];
          if (!params || !Array.isArray(params.Position) || params.Position.length !== 3) {
            throw new Error('bim.store.addColumn: params.Position must be [x, y, z]');
          }
          if (!params.Position.every((n) => typeof n === 'number' && Number.isFinite(n))) {
            throw new Error('bim.store.addColumn: params.Position values must be finite numbers');
          }
          for (const key of ['Width', 'Depth', 'Height'] as const) {
            const v = params[key];
            if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
              throw new Error(`bim.store.addColumn: params.${key} must be a finite number > 0, got ${v}`);
            }
          }
          return sdk.store.addColumn(args[0] as string, storeyExpressId, params);
        },
        returns: 'value',
      },
      {
        name: 'addWall',
        doc: 'Add an IfcWall from Start to End anchored to an IfcBuildingStorey. Returns the new wall entity ref.',
        args: ['string', 'number', 'dump'],
        paramNames: ['modelId', 'storeyExpressId', 'params'],
        tsParamTypes: [
          'string',
          'number',
          '{ Start: [number, number, number]; End: [number, number, number]; Thickness: number; Height: number; Name?: string; Description?: string; ObjectType?: string; Tag?: string }',
        ],
        tsReturn: '{ modelId: string; expressId: number }',
        call: (sdk, args) => {
          const storeyExpressId = args[1] as number;
          if (!Number.isInteger(storeyExpressId) || storeyExpressId < 0) {
            throw new Error(`bim.store.addWall: storeyExpressId must be a non-negative integer, got ${storeyExpressId}`);
          }
          const params = args[2] as Parameters<typeof sdk.store.addWall>[2];
          if (
            !params
            || !Array.isArray(params.Start) || params.Start.length !== 3
            || !Array.isArray(params.End) || params.End.length !== 3
          ) {
            throw new Error('bim.store.addWall: params.Start and params.End must be [x, y, z]');
          }
          if (!params.Start.every((n) => typeof n === 'number' && Number.isFinite(n))
              || !params.End.every((n) => typeof n === 'number' && Number.isFinite(n))) {
            throw new Error('bim.store.addWall: Start/End values must be finite numbers');
          }
          for (const key of ['Thickness', 'Height'] as const) {
            const v = params[key];
            if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
              throw new Error(`bim.store.addWall: params.${key} must be a finite number > 0, got ${v}`);
            }
          }
          return sdk.store.addWall(args[0] as string, storeyExpressId, params);
        },
        returns: 'value',
      },
      {
        name: 'addSlab',
        doc: 'Add an IfcSlab anchored to an IfcBuildingStorey. Two modes: rectangle (Position + Width + Depth) or polygon (OuterCurve = Array<[x, y]> with ≥3 points).',
        args: ['string', 'number', 'dump'],
        paramNames: ['modelId', 'storeyExpressId', 'params'],
        tsParamTypes: [
          'string',
          'number',
          '{ Position: [number, number, number]; Width: number; Depth: number; Thickness: number; Profile?: "rectangle"; Name?: string; Description?: string; ObjectType?: string; Tag?: string } | { Profile: "polygon"; OuterCurve: Array<[number, number]>; Position?: [number, number, number]; Thickness: number; Name?: string; Description?: string; ObjectType?: string; Tag?: string }',
        ],
        tsReturn: '{ modelId: string; expressId: number }',
        call: (sdk, args) => {
          const storeyExpressId = args[1] as number;
          if (!Number.isInteger(storeyExpressId) || storeyExpressId < 0) {
            throw new Error(`bim.store.addSlab: storeyExpressId must be a non-negative integer, got ${storeyExpressId}`);
          }
          const params = args[2] as Parameters<typeof sdk.store.addSlab>[2];
          if (!params) {
            throw new Error('bim.store.addSlab: params is required');
          }
          const thickness = (params as { Thickness?: unknown }).Thickness;
          if (typeof thickness !== 'number' || !Number.isFinite(thickness) || thickness <= 0) {
            throw new Error(`bim.store.addSlab: params.Thickness must be a finite number > 0, got ${thickness}`);
          }
          if ((params as { Profile?: unknown }).Profile === 'polygon') {
            const polygon = params as { Profile: 'polygon'; OuterCurve: unknown; Position?: unknown };
            if (!Array.isArray(polygon.OuterCurve) || polygon.OuterCurve.length < 3) {
              throw new Error('bim.store.addSlab: polygon OuterCurve needs at least 3 points');
            }
            for (const pt of polygon.OuterCurve) {
              if (!Array.isArray(pt) || pt.length !== 2
                  || typeof pt[0] !== 'number' || !Number.isFinite(pt[0])
                  || typeof pt[1] !== 'number' || !Number.isFinite(pt[1])) {
                throw new Error('bim.store.addSlab: each OuterCurve point must be [number, number] of finite values');
              }
            }
            if (polygon.Position !== undefined) {
              if (!Array.isArray(polygon.Position) || polygon.Position.length !== 3
                  || !polygon.Position.every((n) => typeof n === 'number' && Number.isFinite(n))) {
                throw new Error('bim.store.addSlab: params.Position must be [x, y, z] of finite numbers');
              }
            }
          } else {
            const rect = params as { Position: unknown; Width: unknown; Depth: unknown };
            if (!Array.isArray(rect.Position) || rect.Position.length !== 3
                || !rect.Position.every((n) => typeof n === 'number' && Number.isFinite(n))) {
              throw new Error('bim.store.addSlab: params.Position must be [x, y, z] of finite numbers');
            }
            for (const key of ['Width', 'Depth'] as const) {
              const v = (rect as Record<string, unknown>)[key];
              if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
                throw new Error(`bim.store.addSlab: params.${key} must be a finite number > 0, got ${v}`);
              }
            }
          }
          return sdk.store.addSlab(args[0] as string, storeyExpressId, params);
        },
        returns: 'value',
      },
      {
        name: 'addBeam',
        doc: 'Add an IfcBeam from Start to End with a centred rectangular cross-section.',
        args: ['string', 'number', 'dump'],
        paramNames: ['modelId', 'storeyExpressId', 'params'],
        tsParamTypes: [
          'string',
          'number',
          '{ Start: [number, number, number]; End: [number, number, number]; Width: number; Height: number; Name?: string; Description?: string; ObjectType?: string; Tag?: string }',
        ],
        tsReturn: '{ modelId: string; expressId: number }',
        call: (sdk, args) => {
          const storeyExpressId = args[1] as number;
          if (!Number.isInteger(storeyExpressId) || storeyExpressId < 0) {
            throw new Error(`bim.store.addBeam: storeyExpressId must be a non-negative integer, got ${storeyExpressId}`);
          }
          const params = args[2] as Parameters<typeof sdk.store.addBeam>[2];
          if (
            !params
            || !Array.isArray(params.Start) || params.Start.length !== 3
            || !Array.isArray(params.End) || params.End.length !== 3
          ) {
            throw new Error('bim.store.addBeam: params.Start and params.End must be [x, y, z]');
          }
          if (!params.Start.every((n) => typeof n === 'number' && Number.isFinite(n))
              || !params.End.every((n) => typeof n === 'number' && Number.isFinite(n))) {
            throw new Error('bim.store.addBeam: Start/End values must be finite numbers');
          }
          for (const key of ['Width', 'Height'] as const) {
            const v = params[key];
            if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
              throw new Error(`bim.store.addBeam: params.${key} must be a finite number > 0, got ${v}`);
            }
          }
          return sdk.store.addBeam(args[0] as string, storeyExpressId, params);
        },
        returns: 'value',
      },
      {
        name: 'addDoor',
        doc: 'Add a free-standing IfcDoor anchored to an IfcBuildingStorey.',
        args: ['string', 'number', 'dump'],
        paramNames: ['modelId', 'storeyExpressId', 'params'],
        tsParamTypes: [
          'string',
          'number',
          '{ Position: [number, number, number]; Width: number; Height: number; FrameThickness?: number; PredefinedType?: string; OperationType?: string; Name?: string; Description?: string; ObjectType?: string; Tag?: string }',
        ],
        tsReturn: '{ modelId: string; expressId: number }',
        call: (sdk, args) => {
          const storeyExpressId = requireStoreyId(args[1] as number, 'addDoor');
          const params = args[2] as Parameters<typeof sdk.store.addDoor>[2];
          requirePositionVec3(params?.Position, 'addDoor');
          requirePositiveDims(params, ['Width', 'Height'], 'addDoor');
          if (params.FrameThickness !== undefined) requirePositiveDims(params, ['FrameThickness'], 'addDoor');
          return sdk.store.addDoor(args[0] as string, storeyExpressId, params);
        },
        returns: 'value',
      },
      {
        name: 'addWindow',
        doc: 'Add a free-standing IfcWindow anchored to an IfcBuildingStorey.',
        args: ['string', 'number', 'dump'],
        paramNames: ['modelId', 'storeyExpressId', 'params'],
        tsParamTypes: [
          'string',
          'number',
          '{ Position: [number, number, number]; Width: number; Height: number; FrameThickness?: number; PredefinedType?: string; PartitioningType?: string; Name?: string; Description?: string; ObjectType?: string; Tag?: string }',
        ],
        tsReturn: '{ modelId: string; expressId: number }',
        call: (sdk, args) => {
          const storeyExpressId = requireStoreyId(args[1] as number, 'addWindow');
          const params = args[2] as Parameters<typeof sdk.store.addWindow>[2];
          requirePositionVec3(params?.Position, 'addWindow');
          requirePositiveDims(params, ['Width', 'Height'], 'addWindow');
          if (params.FrameThickness !== undefined) requirePositiveDims(params, ['FrameThickness'], 'addWindow');
          return sdk.store.addWindow(args[0] as string, storeyExpressId, params);
        },
        returns: 'value',
      },
      {
        name: 'addSpace',
        doc: 'Add an IfcSpace (room) — rectangle or polygon footprint extruded by Height. Aggregated under the storey via IfcRelAggregates.',
        args: ['string', 'number', 'dump'],
        paramNames: ['modelId', 'storeyExpressId', 'params'],
        tsParamTypes: [
          'string',
          'number',
          '{ Position: [number, number, number]; Width: number; Depth: number; Height: number; Profile?: "rectangle"; Name?: string; LongName?: string; Description?: string; ObjectType?: string } | { Profile: "polygon"; OuterCurve: Array<[number, number]>; Position?: [number, number, number]; Height: number; Name?: string; LongName?: string; Description?: string; ObjectType?: string }',
        ],
        tsReturn: '{ modelId: string; expressId: number }',
        call: (sdk, args) => {
          const storeyExpressId = requireStoreyId(args[1] as number, 'addSpace');
          const params = args[2] as Parameters<typeof sdk.store.addSpace>[2];
          if (!params) throw new Error('bim.store.addSpace: params is required');
          requirePositiveDims(params, ['Height'], 'addSpace');
          validateProfileParams(params, 'addSpace', ['Width', 'Depth']);
          return sdk.store.addSpace(args[0] as string, storeyExpressId, params);
        },
        returns: 'value',
      },
      {
        name: 'addRoof',
        doc: 'Add an IfcRoof (flat-roof slab variant). Two modes: rectangle or polygon.',
        args: ['string', 'number', 'dump'],
        paramNames: ['modelId', 'storeyExpressId', 'params'],
        tsParamTypes: [
          'string',
          'number',
          '{ Position: [number, number, number]; Width: number; Depth: number; Thickness: number; Profile?: "rectangle"; Name?: string; Description?: string; ObjectType?: string; Tag?: string } | { Profile: "polygon"; OuterCurve: Array<[number, number]>; Position?: [number, number, number]; Thickness: number; Name?: string; Description?: string; ObjectType?: string; Tag?: string }',
        ],
        tsReturn: '{ modelId: string; expressId: number }',
        call: (sdk, args) => {
          const storeyExpressId = requireStoreyId(args[1] as number, 'addRoof');
          const params = args[2] as Parameters<typeof sdk.store.addRoof>[2];
          if (!params) throw new Error('bim.store.addRoof: params is required');
          requirePositiveDims(params, ['Thickness'], 'addRoof');
          validateProfileParams(params, 'addRoof', ['Width', 'Depth']);
          return sdk.store.addRoof(args[0] as string, storeyExpressId, params);
        },
        returns: 'value',
      },
      {
        name: 'addPlate',
        doc: 'Add an IfcPlate (thin flat element). Two modes: rectangle or polygon.',
        args: ['string', 'number', 'dump'],
        paramNames: ['modelId', 'storeyExpressId', 'params'],
        tsParamTypes: [
          'string',
          'number',
          '{ Position: [number, number, number]; Width: number; Depth: number; Thickness: number; Profile?: "rectangle"; PredefinedType?: string; Name?: string; Description?: string; ObjectType?: string; Tag?: string } | { Profile: "polygon"; OuterCurve: Array<[number, number]>; Position?: [number, number, number]; Thickness: number; PredefinedType?: string; Name?: string; Description?: string; ObjectType?: string; Tag?: string }',
        ],
        tsReturn: '{ modelId: string; expressId: number }',
        call: (sdk, args) => {
          const storeyExpressId = requireStoreyId(args[1] as number, 'addPlate');
          const params = args[2] as Parameters<typeof sdk.store.addPlate>[2];
          if (!params) throw new Error('bim.store.addPlate: params is required');
          requirePositiveDims(params, ['Thickness'], 'addPlate');
          validateProfileParams(params, 'addPlate', ['Width', 'Depth']);
          return sdk.store.addPlate(args[0] as string, storeyExpressId, params);
        },
        returns: 'value',
      },
      {
        name: 'addMember',
        doc: 'Add an IfcMember (generic structural — brace, post, strut) from Start to End with a rectangular cross-section.',
        args: ['string', 'number', 'dump'],
        paramNames: ['modelId', 'storeyExpressId', 'params'],
        tsParamTypes: [
          'string',
          'number',
          '{ Start: [number, number, number]; End: [number, number, number]; Width: number; Height: number; PredefinedType?: string; Name?: string; Description?: string; ObjectType?: string; Tag?: string }',
        ],
        tsReturn: '{ modelId: string; expressId: number }',
        call: (sdk, args) => {
          const storeyExpressId = requireStoreyId(args[1] as number, 'addMember');
          const params = args[2] as Parameters<typeof sdk.store.addMember>[2];
          requireAxisVec3(params?.Start, 'addMember', 'Start');
          requireAxisVec3(params?.End, 'addMember', 'End');
          requirePositiveDims(params, ['Width', 'Height'], 'addMember');
          return sdk.store.addMember(args[0] as string, storeyExpressId, params);
        },
        returns: 'value',
      },
    ],
  };
}

// ---------------------------------------------------------------------
// Local validation helpers — keeps the addX call-handlers terse while
// still throwing precise errors at the bridge boundary. Mirrors the
// ad-hoc checks the earlier addColumn/addWall paths use.
// ---------------------------------------------------------------------

function requireStoreyId(id: number, op: string): number {
  if (!Number.isInteger(id) || id < 0) {
    throw new Error(`bim.store.${op}: storeyExpressId must be a non-negative integer, got ${id}`);
  }
  return id;
}

function requirePositionVec3(pos: unknown, op: string): asserts pos is [number, number, number] {
  if (!Array.isArray(pos) || pos.length !== 3 || !pos.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error(`bim.store.${op}: params.Position must be [x, y, z] of finite numbers`);
  }
}

function requireAxisVec3(pos: unknown, op: string, fieldName: string): asserts pos is [number, number, number] {
  if (!Array.isArray(pos) || pos.length !== 3 || !pos.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error(`bim.store.${op}: params.${fieldName} must be [x, y, z] of finite numbers`);
  }
}

function requirePositiveDims(params: unknown, keys: ReadonlyArray<string>, op: string): void {
  const obj = params as Record<string, unknown>;
  for (const key of keys) {
    const v = obj?.[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(`bim.store.${op}: params.${key} must be a finite number > 0, got ${v}`);
    }
  }
}

/**
 * Validate a discriminated rectangle/polygon profile params object —
 * shared between addSlab / addSpace / addRoof / addPlate. Skips
 * Position when the polygon path omits it (defaults to [0,0,0]).
 */
function validateProfileParams(
  params: { Profile?: unknown; Position?: unknown; OuterCurve?: unknown },
  op: string,
  rectDims: ReadonlyArray<string>,
): void {
  if (params.Profile === 'polygon') {
    if (!Array.isArray(params.OuterCurve) || params.OuterCurve.length < 3) {
      throw new Error(`bim.store.${op}: polygon OuterCurve needs at least 3 points`);
    }
    for (const pt of params.OuterCurve) {
      if (!Array.isArray(pt) || pt.length !== 2
          || typeof pt[0] !== 'number' || !Number.isFinite(pt[0])
          || typeof pt[1] !== 'number' || !Number.isFinite(pt[1])) {
        throw new Error(`bim.store.${op}: each OuterCurve point must be [number, number] of finite values`);
      }
    }
    if (params.Position !== undefined) {
      requirePositionVec3(params.Position, op);
    }
  } else {
    requirePositionVec3((params as { Position: unknown }).Position, op);
    requirePositiveDims(params, rectDims, op);
  }
}
