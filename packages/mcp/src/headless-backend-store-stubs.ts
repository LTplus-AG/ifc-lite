/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `bim.store` authoring surfaces MCP v0.1 deliberately does not implement:
 * cost (#4857) and structural analysis (#5167 S.1). Agent flows author through
 * `entity_create` with raw attributes, so these throw loudly rather than
 * silently no-opping.
 *
 * Composed into one spread so `headless-backend.ts` gains a surface, not a
 * line, each time another factory-backed store surface is added to the SDK.
 * Reads (`bim.cost`, `bim.structural`) are unaffected and already observe
 * whatever `entity_create` authored.
 */

import type { CostStoreBackendMethods, StructuralStoreBackendMethods } from '@ifc-lite/sdk';
import { costStoreStubs } from './headless-backend-cost-store.js';
import { structuralStoreStubs } from './headless-backend-structural-store.js';

export function unsupportedStoreAuthoring(): CostStoreBackendMethods & StructuralStoreBackendMethods {
  return { ...costStoreStubs(), ...structuralStoreStubs() };
}
