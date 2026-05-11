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
/**
 * Parse a STEP express-id string as a strict positive decimal integer.
 * Rejects everything `Number()` quietly accepts but is wrong for STEP
 * ids: blank/whitespace strings, hex (`0x42`), scientific notation
 * (`1e3`), floats, signed values, leading-zero forms beyond a single
 * zero. Returning `null` instead of throwing so callers can decide
 * whether the bad id is fatal (toGlobalId) or just skippable
 * (fromGlobalId / getModelForGlobalId).
 */
function parseExpressId(value: string): number | null {
  if (typeof value !== 'string') return null;
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  // Within JS safe-integer range — STEP files rarely exceed millions
  // of entities, but reject anything that would lose precision.
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function createNumericRegistryAdapter(
  registry: NumericFederationRegistry,
): FederationResolver {
  return {
    toGlobalId(modelId, localId) {
      const expressId = parseExpressId(localId);
      if (expressId === null) {
        throw new Error(
          `@ifc-lite/collab: numeric registry adapter requires numeric local ids (positive decimal integers), got "${localId}"`,
        );
      }
      return String(registry.toGlobalId(modelId, expressId));
    },
    fromGlobalId(globalId) {
      const n = parseExpressId(globalId);
      if (n === null) return null;
      const r = registry.fromGlobalId(n);
      return r ? { modelId: r.modelId, globalId: String(r.expressId) } : null;
    },
    getModelForGlobalId(globalId) {
      const n = parseExpressId(globalId);
      if (n === null) return null;
      return registry.getModelForGlobalId(n);
    },
  };
}
