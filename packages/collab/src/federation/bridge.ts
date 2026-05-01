/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridge from `@ifc-lite/collab`'s `FederationResolver` to a
 * legacy-STEP-shaped registry that uses numeric `expressId`s and an
 * offset-based scheme (e.g. the `FederationRegistry` in
 * `@ifc-lite/renderer`).
 *
 * The bridge keeps `@ifc-lite/collab` decoupled from the renderer
 * package — apps wrap whichever registry they have with this helper.
 *
 * Example wiring:
 *
 *   import { federationRegistry } from '@ifc-lite/renderer';
 *   import { createNumericRegistryAdapter } from '@ifc-lite/collab';
 *
 *   const resolver = createNumericRegistryAdapter(federationRegistry);
 *
 *   const fed = await createFederationSession({
 *     projectId, user, models, // …
 *   });
 *   // Pass `resolver` to wherever cross-model identifiers need to
 *   // be turned into numeric global ids for the renderer.
 */

import type { FederationResolver } from './resolver.js';

/** Shape that `@ifc-lite/renderer.FederationRegistry` already implements. */
export interface NumericFederationRegistry {
  toGlobalId(modelId: string, expressId: number): number;
  fromGlobalId(globalId: number): { modelId: string; expressId: number } | null;
  getModelForGlobalId(globalId: number): string | null;
}

/**
 * Wrap a numeric-offset registry in our typed `FederationResolver`
 * interface. We carry the underlying numeric global id as a string so
 * `FederationRecord.refs.globalId: string` round-trips losslessly.
 */
export function createNumericRegistryAdapter(
  registry: NumericFederationRegistry,
): FederationResolver {
  return {
    toGlobalId(modelId, localId) {
      const expressId = Number(localId);
      if (!Number.isFinite(expressId)) {
        throw new Error(
          `@ifc-lite/collab: numeric registry adapter requires numeric local ids, got "${localId}"`,
        );
      }
      return String(registry.toGlobalId(modelId, expressId));
    },
    fromGlobalId(globalId) {
      const n = Number(globalId);
      if (!Number.isFinite(n)) return null;
      const r = registry.fromGlobalId(n);
      return r ? { modelId: r.modelId, globalId: String(r.expressId) } : null;
    },
    getModelForGlobalId(globalId) {
      const n = Number(globalId);
      if (!Number.isFinite(n)) return null;
      return registry.getModelForGlobalId(n);
    },
  };
}
