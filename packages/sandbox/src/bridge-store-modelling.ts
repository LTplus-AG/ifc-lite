/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.store.addOpening` / `addHostedDoor` / `addHostedWindow` in the sandbox
 * (#6232). Dimension and placement validation lives in the `@ifc-lite/create`
 * builders, which throw precise messages; the bridge only rejects arguments
 * that could not be a host id or a params object at all.
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

/** Openings and wall-hosted doors/windows, cut into an existing IfcWall / IfcSlab. */
export function buildStoreModellingMethods(): MethodSchema[] {
  return [
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
  ];
}
