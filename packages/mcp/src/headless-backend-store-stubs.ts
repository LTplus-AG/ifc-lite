/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `bim.store` authoring surfaces MCP v0.1 deliberately does not implement:
 * cost (#4857), structural analysis (#5167 S.1), type objects and materials.
 * Hosted openings, doors and windows use the shared SDK factory (#6232 D5).
 * Other agent flows author through `entity_create` with raw
 * attributes, so these throw loudly rather than silently no-opping.
 *
 * Composed into one spread so `headless-backend.ts` gains a surface, not a
 * line, each time another factory-backed store surface is added to the SDK.
 */

import type {
  CostStoreBackendMethods,
  ModellingStoreBackendMethods,
  StructuralStoreBackendMethods,
} from '@ifc-lite/sdk';
import { costStoreStubs } from './headless-backend-cost-store.js';
import { structuralStoreStubs } from './headless-backend-structural-store.js';

const unsupported = (method: string) => (): never => {
  throw new Error(`${method} not supported in MCP v0.1; use entity_create`);
};

type RelationshipMethods = Omit<ModellingStoreBackendMethods, 'addOpening' | 'addHostedDoor' | 'addHostedWindow' | 'joinWalls'>;

export function unsupportedStoreAuthoring(): CostStoreBackendMethods & StructuralStoreBackendMethods & RelationshipMethods {
  return {
    ...costStoreStubs(), ...structuralStoreStubs(),
    addElementType: unsupported('addElementType'),
    assignType: unsupported('assignType'),
    addMaterial: unsupported('addMaterial'),
    addMaterialLayerSet: unsupported('addMaterialLayerSet'),
    addMaterialLayerSetUsage: unsupported('addMaterialLayerSetUsage'),
    assignMaterial: unsupported('assignMaterial'),
  };
}
