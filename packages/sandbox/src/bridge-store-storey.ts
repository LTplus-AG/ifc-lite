/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The storey authoring surface of `bim.store` in the sandbox (#9025): the
 * same plan/apply path as the viewer's storey manager and MCP. The
 * `@ifc-lite/create` planner decides every refusal with a precise message;
 * the bridge only rejects arguments that could not be an id, a mode or a
 * params object at all. Lengths are metres.
 */

import type { BimContext } from '@ifc-lite/sdk';
import type { MethodSchema } from './bridge-schema.js';

const ENTITY_REF = '{ modelId: string; expressId: number }';

function requireId(name: string, label: string, value: unknown): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`bim.store.${name}: ${label} must be a positive integer, got ${String(value)}`);
  }
  return value as number;
}

/** A plain object argument, typed as what the SDK method takes; its fields are validated by the planner. */
function requireObject<T>(name: string, label: string, value: unknown): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`bim.store.${name}: ${label} must be an object`);
  return value as T;
}

type StoreApi = BimContext['store'];

/** The reviewed plan a write may be pinned to: absent, or the object a dry run returned. */
function optionalPlan<T>(name: string, value: unknown): T | undefined {
  return value === undefined || value === null ? undefined : requireObject<T>(name, 'expected', value);
}

function levelEdit(name: string, value: unknown): Parameters<StoreApi['editStorey']>[1] {
  const edit = requireObject<Parameters<StoreApi['editStorey']>[1]>(name, 'edit', value);
  if (edit.kind !== 'elevation' && edit.kind !== 'floorHeight') throw new Error(`bim.store.${name}: edit.kind must be "elevation" or "floorHeight"`);
  requireId(name, 'edit.storeyId', edit.storeyId);
  return edit;
}

function deleteMode(name: string, value: unknown): Parameters<StoreApi['deleteStorey']>[1] {
  const mode = requireObject<Parameters<StoreApi['deleteStorey']>[1]>(name, 'mode', value);
  if (mode.kind === 'move') requireId(name, 'mode.targetStoreyId', mode.targetStoreyId);
  else if (mode.kind !== 'empty' && mode.kind !== 'deleteContents') throw new Error(`bim.store.${name}: mode.kind must be "empty", "move" or "deleteContents"`);
  return mode;
}

/** List, suggest, add, rename, plan, re-level and delete storeys. */
export function buildStoreStoreyMethods(): MethodSchema[] {
  return [
    {
      name: 'listStoreyLevels',
      doc: 'List the live storeys of a model, highest first, with elevation (m), floor-to-floor height to the storey above in the same building (m, null for the top) and element count.',
      args: ['string'], paramNames: ['modelId'], tsParamTypes: ['string'],
      tsReturn: 'BimCreate.StoreySummary[]', returns: 'value',
      call: (sdk, args) => sdk.store.listStoreyLevels(args[0] as string),
    },
    {
      name: 'suggestStorey',
      doc: 'The default Name, Elevation and floor-to-floor height for a new storey above or below a storey, from its neighbours. Writes nothing.',
      args: ['string', 'number', 'string'], paramNames: ['modelId', 'referenceStoreyId', 'side'],
      tsParamTypes: ['string', 'number', "'above' | 'below'"], tsReturn: 'BimCreate.StoreySuggestion', returns: 'value',
      call: (sdk, args) => {
        if (args[2] !== 'above' && args[2] !== 'below') throw new Error('bim.store.suggestStorey: side must be "above" or "below"');
        return sdk.store.suggestStorey(args[0] as string, requireId('suggestStorey', 'referenceStoreyId', args[1]), args[2]);
      },
    },
    {
      name: 'addStorey',
      doc: 'Add an IfcBuildingStorey aggregated under its building and placed like its neighbours. Refused (nothing written) for an empty name or an elevation another storey of that building occupies. One Undo.',
      args: ['string', 'dump'], paramNames: ['modelId', 'params'], tsParamTypes: ['string', 'BimCreate.AddStoreyParams'],
      tsReturn: ENTITY_REF, returns: 'value',
      call: (sdk, args) => sdk.store.addStorey(args[0] as string, requireObject<Parameters<StoreApi['addStorey']>[1]>('addStorey', 'params', args[1])),
    },
    {
      name: 'renameStorey',
      doc: 'Rename a storey (IfcRoot.Name). One Undo.',
      args: ['dump', 'string'], paramNames: ['ref', 'Name'], tsParamTypes: [ENTITY_REF, 'string'], tsReturn: ENTITY_REF, returns: 'value',
      call: (sdk, args) => sdk.store.renameStorey(requireObject<Parameters<StoreApi['renameStorey']>[0]>('renameStorey', 'ref', args[0]), args[1] as string),
    },
    {
      name: 'planStoreyEdit',
      doc: 'Dry run of editStorey: the storeys and elements that would move, the walls that resize and the stairs that refit, every refusal and the notices for elements left as they are. Writes nothing.',
      args: ['string', 'dump'], paramNames: ['modelId', 'edit'], tsParamTypes: ['string', 'BimCreate.StoreyLevelEdit'],
      tsReturn: 'BimCreate.StoreyLevelPlan', returns: 'value',
      call: (sdk, args) => sdk.store.planStoreyEdit(args[0] as string, levelEdit('planStoreyEdit', args[1])),
    },
    {
      name: 'editStorey',
      doc: '{ kind: "elevation", storeyId, Elevation } moves that storey only; { kind: "floorHeight", storeyId, Height } shifts every storey above in its building by the same amount. Geometry follows (contents move, attached walls resize, stairs refit); refused with nothing written when planStoreyEdit reports a refusal, or when `expected` (a planStoreyEdit result) no longer matches the model. One Undo.',
      args: ['string', 'dump', 'dump'], paramNames: ['modelId', 'edit', 'expected'], tsParamTypes: ['string', 'BimCreate.StoreyLevelEdit', 'BimCreate.StoreyLevelPlan | undefined'],
      tsReturn: `${ENTITY_REF}[]`, returns: 'value',
      call: (sdk, args) => sdk.store.editStorey(args[0] as string, levelEdit('editStorey', args[1]), optionalPlan<Parameters<StoreApi['editStorey']>[2]>('editStorey', args[2])),
    },
    {
      name: 'planStoreyDelete',
      doc: 'Dry run of deleteStorey: what the storey holds and any refusal. Writes nothing.',
      args: ['dump', 'dump'], paramNames: ['ref', 'mode'], tsParamTypes: [ENTITY_REF, 'BimCreate.StoreyDeleteMode'],
      tsReturn: 'BimCreate.StoreyDeletePlan', returns: 'value',
      call: (sdk, args) => sdk.store.planStoreyDelete(requireObject<Parameters<StoreApi['planStoreyDelete']>[0]>('planStoreyDelete', 'ref', args[0]), deleteMode('planStoreyDelete', args[1])),
    },
    {
      name: 'deleteStorey',
      doc: 'Delete a storey without orphaning anything: { kind: "empty" } (refused while it holds elements), { kind: "move", targetStoreyId } or { kind: "deleteContents" }. Pass the planStoreyDelete result as `expected` so contents added since are refused, not deleted. A model keeps one storey. One Undo.',
      args: ['dump', 'dump', 'dump'], paramNames: ['ref', 'mode', 'expected'], tsParamTypes: [ENTITY_REF, 'BimCreate.StoreyDeleteMode', 'BimCreate.StoreyDeletePlan | undefined'],
      tsReturn: `${ENTITY_REF}[]`, returns: 'value',
      call: (sdk, args) => sdk.store.deleteStorey(
        requireObject<Parameters<StoreApi['deleteStorey']>[0]>('deleteStorey', 'ref', args[0]), deleteMode('deleteStorey', args[1]),
        optionalPlan<Parameters<StoreApi['deleteStorey']>[2]>('deleteStorey', args[2]),
      ),
    },
  ];
}
