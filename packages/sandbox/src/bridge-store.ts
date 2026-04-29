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
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) {
            throw new Error('bim.store.setPositionalAttribute: invalid entity reference');
          }
          sdk.store.setPositionalAttribute(ref, args[1] as number, args[2]);
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
          const params = args[2] as Parameters<typeof sdk.store.addColumn>[2];
          if (!params || !Array.isArray(params.Position) || params.Position.length !== 3) {
            throw new Error('bim.store.addColumn: params.Position must be [x, y, z]');
          }
          return sdk.store.addColumn(args[0] as string, args[1] as number, params);
        },
        returns: 'value',
      },
    ],
  };
}
