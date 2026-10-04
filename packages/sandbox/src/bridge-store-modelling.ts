/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The #6232 `bim.store` modelling surface in the sandbox: openings, hosted
 * doors/windows, type objects and materials. Dimension, enum and placement
 * validation lives in the `@ifc-lite/create` builders, which throw precise
 * messages; the bridge only rejects arguments that could not be an entity id,
 * an id list or a params object at all.
 */

import type { MethodSchema } from './bridge-schema.js';

const ENTITY_REF = '{ modelId: string; expressId: number }';
const COMMON = 'Name?: string; Description?: string; ObjectType?: string; Tag?: string; GlobalId?: string';
const WALL_OPENING = `{ Offset: number; Sill?: number; Width: number; Height: number; CutDepth?: number; ${COMMON} }`;
const SLAB_OPENING = `{ Position: [number, number]; Width: number; Depth: number; CutDepth?: number; ${COMMON} }`;
const HOSTED = `Offset: number; Width: number; Height: number; CutDepth?: number; FrameThickness?: number; PredefinedType?: string; ${COMMON}`;

type HostedMethod = 'addOpening' | 'addHostedDoor' | 'addHostedWindow';

function hostedMethod(name: HostedMethod, doc: string, paramsType: string): MethodSchema {
  return {
    name,
    doc,
    args: ['string', 'number', 'dump'],
    paramNames: ['modelId', 'hostExpressId', 'params'],
    tsParamTypes: ['string', 'number', paramsType],
    tsReturn: ENTITY_REF,
    call: (sdk, args) => {
      const hostExpressId = args[1] as number;
      if (!Number.isInteger(hostExpressId) || hostExpressId <= 0) {
        throw new Error(`bim.store.${name}: hostExpressId must be a positive integer, got ${hostExpressId}`);
      }
      const params = args[2];
      if (!params || typeof params !== 'object') throw new Error(`bim.store.${name}: params is required`);
      const method = sdk.store[name] as (modelId: string, host: number, p: Parameters<typeof sdk.store[HostedMethod]>[2]) => unknown;
      return method.call(sdk.store, args[0] as string, hostExpressId, params as Parameters<typeof sdk.store[HostedMethod]>[2]);
    },
    returns: 'value',
  };
}

function requireId(name: string, label: string, value: unknown): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`bim.store.${name}: ${label} must be a positive integer, got ${String(value)}`);
  }
  return value as number;
}

type ParamsMethod = 'addElementType' | 'addMaterial' | 'addMaterialLayerSet' | 'addMaterialLayerSetUsage';

function paramsMethod(name: ParamsMethod, doc: string, paramsType: string): MethodSchema {
  return {
    name,
    doc,
    args: ['string', 'dump'],
    paramNames: ['modelId', 'params'],
    tsParamTypes: ['string', paramsType],
    tsReturn: ENTITY_REF,
    call: (sdk, args) => {
      if (!args[1] || typeof args[1] !== 'object') throw new Error(`bim.store.${name}: params is required`);
      const method = sdk.store[name] as (modelId: string, p: Parameters<typeof sdk.store[ParamsMethod]>[1]) => unknown;
      return method.call(sdk.store, args[0] as string, args[1] as Parameters<typeof sdk.store[ParamsMethod]>[1]);
    },
    returns: 'value',
  };
}

function assignMethod(name: 'assignType' | 'assignMaterial', relatingName: string, doc: string): MethodSchema {
  return {
    name,
    doc,
    args: ['string', 'number', 'dump'],
    paramNames: ['modelId', relatingName, 'objectExpressIds'],
    tsParamTypes: ['string', 'number', 'number[]'],
    tsReturn: ENTITY_REF,
    call: (sdk, args) => {
      const relating = requireId(name, relatingName, args[1]);
      if (!Array.isArray(args[2]) || args[2].length === 0) throw new Error(`bim.store.${name}: objectExpressIds must be a non-empty array`);
      const objects = args[2].map((id) => requireId(name, 'objectExpressIds[]', id));
      return sdk.store[name](args[0] as string, relating, objects);
    },
    returns: 'value',
  };
}

const LAYER = '{ Material?: number; LayerThickness: number; IsVentilated?: boolean; Name?: string; Description?: string; Category?: string; Priority?: number }';

/** Openings, wall-hosted doors/windows, type objects and materials. */
export function buildStoreModellingMethods(): MethodSchema[] {
  return [
    {
      name: 'alignElements',
      doc: 'Align real native mesh edges or centres in one storey workplane. Fresh geometry and an atomic transaction preserve hosted cuts, joined neighbours and one Undo.',
      args: ['string', 'number', 'dump', 'string'],
      paramNames: ['modelId', 'reference', 'targets', 'mode'],
      tsParamTypes: ['string', 'number', 'readonly number[]', 'BimCreate.AlignMode'],
      tsReturn: `Promise<${ENTITY_REF}[]>`,
      returns: 'value',
      call: (sdk, args) => sdk.store.alignElements(args[0] as string, requireId('alignElements', 'reference', args[1]), args[2] as number[], args[3] as Parameters<typeof sdk.store.alignElements>[3]),
    },
    {
      name: 'joinWalls',
      doc: 'Join two straight walls in the same placement frame through IfcRelConnectsPathElements. Uses the Model workspace core, preserving readable hosted openings and refusing a cut stranded by a joined end face.',
      args: ['string', 'number', 'number', 'dump'],
      paramNames: ['modelId', 'aExpressId', 'bExpressId', 'options?'],
      tsParamTypes: ['string', 'number', 'number', 'BimCreate.WallJoinApplyOptions'],
      tsReturn: ENTITY_REF,
      returns: 'value',
      call: (sdk, args) => {
        const a = requireId('joinWalls', 'aExpressId', args[1]);
        const b = requireId('joinWalls', 'bExpressId', args[2]);
        if (args[3] !== undefined && (!args[3] || typeof args[3] !== 'object' || Array.isArray(args[3]))) {
          throw new Error('bim.store.joinWalls: options must be an object');
        }
        return sdk.store.joinWalls(args[0] as string, a, b, args[3] as Parameters<typeof sdk.store.joinWalls>[3]);
      },
    },
    hostedMethod(
      'addOpening',
      'Cut an IfcOpeningElement (IfcRelVoidsElement) into an existing IfcWall or IfcSlab. Metres, in the host placement frame.',
      `${WALL_OPENING} | ${SLAB_OPENING}`,
    ),
    hostedMethod(
      'addHostedDoor',
      'Add an IfcDoor filling a new opening in an existing IfcWall (IfcRelFillsElement). Offset is along the wall axis to the door centre.',
      `{ ${HOSTED}; Sill?: number; OperationType?: string; UserDefinedOperationType?: string }`,
    ),
    hostedMethod(
      'addHostedWindow',
      'Add an IfcWindow filling a new opening in an existing IfcWall (IfcRelFillsElement). Sill is the bottom edge height.',
      `{ ${HOSTED}; Sill: number; PartitioningType?: string; UserDefinedPartitioningType?: string }`,
    ),
    paramsMethod(
      'addElementType',
      "Add an IfcElementType subtype (Type: 'IfcWallType', 'IfcDoorType', ...), laid out for the model's schema. Enum values without dots.",
      '{ Type: string; Name: string; Description?: string; ApplicableOccurrence?: string; Tag?: string; ElementType?: string; PredefinedType?: string; OperationType?: string; UserDefinedOperationType?: string; PartitioningType?: string; UserDefinedPartitioningType?: string; ParameterTakesPrecedence?: boolean; GlobalId?: string }',
    ),
    assignMethod('assignType', 'typeExpressId', 'Type objects via IfcRelDefinesByType; an object already typed moves to this type. Returns the relationship.'),
    paramsMethod('addMaterial', 'Add an IfcMaterial.', '{ Name: string; Description?: string; Category?: string }'),
    paramsMethod(
      'addMaterialLayerSet',
      'Add an IfcMaterialLayerSet with one IfcMaterialLayer per entry (LayerThickness in metres).',
      `{ MaterialLayers: ${LAYER}[]; LayerSetName?: string; Description?: string }`,
    ),
    paramsMethod(
      'addMaterialLayerSetUsage',
      'Add an IfcMaterialLayerSetUsage (default AXIS2 / POSITIVE; OffsetFromReferenceLine in metres).',
      "{ ForLayerSet: number; LayerSetDirection?: 'AXIS1' | 'AXIS2' | 'AXIS3'; DirectionSense?: 'POSITIVE' | 'NEGATIVE'; OffsetFromReferenceLine: number; ReferenceExtent?: number }",
    ),
    assignMethod('assignMaterial', 'materialExpressId', 'Associate a material with objects via IfcRelAssociatesMaterial, replacing their previous one. Returns the relationship.'),
  ];
}
