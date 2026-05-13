/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `FederationResolver` (spec §10.1, AGENTS.md §4).
 *
 * The CRDT layer stores cross-model references as `{ modelId, globalId
 * }` pairs (`FederationRecord.refs`) and asks a resolver to translate
 * between local and global identifiers when needed. We deliberately
 * do NOT pull in `@ifc-lite/renderer`'s `FederationRegistry` here —
 * apps that need it can wrap that class with this interface, and apps
 * that already use IFCX (where path UUIDs are globally unique) can
 * use the pass-through resolver shipped below.
 *
 * Adapter for `@ifc-lite/renderer`'s legacy STEP `FederationRegistry`:
 *
 *   import { federationRegistry } from '@ifc-lite/renderer';
 *   import { type FederationResolver } from '@ifc-lite/collab';
 *
 *   const resolver: FederationResolver = {
 *     toGlobalId(modelId, expressId) {
 *       return String(federationRegistry.toGlobalId(modelId, Number(expressId)));
 *     },
 *     fromGlobalId(globalId) {
 *       const r = federationRegistry.fromGlobalId(Number(globalId));
 *       return r ? { modelId: r.modelId, globalId: String(r.expressId) } : null;
 *     },
 *     getModelForGlobalId(globalId) {
 *       return federationRegistry.getModelForGlobalId(Number(globalId));
 *     },
 *   };
 */

export interface ResolvedReference {
  modelId: string;
  globalId: string;
}

export interface FederationResolver {
  /** Compose a `(modelId, localId)` pair into a global identifier. */
  toGlobalId(modelId: string, localId: string): string;
  /** Decompose a global identifier back into `(modelId, localId)`. Null if unknown. */
  fromGlobalId(globalId: string): ResolvedReference | null;
  /** Convenience: just the modelId. */
  getModelForGlobalId(globalId: string): string | null;
}

/**
 * Pass-through resolver for IFCX path-based identifiers.
 *
 * IFCX paths are UUIDs and are globally unique by construction —
 * `toGlobalId` returns `localId` unchanged, and `fromGlobalId` cannot
 * recover the originating model without external state, so it returns
 * null. Apps that need bidirectional resolution should plug in a
 * registry-backed resolver instead.
 */
export const passThroughResolver: FederationResolver = {
  toGlobalId(_modelId, localId) {
    return localId;
  },
  fromGlobalId() {
    return null;
  },
  getModelForGlobalId() {
    return null;
  },
};

/**
 * Build a resolver backed by an explicit `(globalId → modelId, localId)`
 * map. Useful when paths *aren't* globally unique (rare in IFCX) or
 * when apps maintain their own registry.
 */
export function createMapBackedResolver(
  table: Map<string, ResolvedReference>,
): FederationResolver {
  return {
    toGlobalId(_modelId, localId) {
      return localId;
    },
    fromGlobalId(globalId) {
      const v = table.get(globalId);
      return v ? { modelId: v.modelId, globalId: v.globalId } : null;
    },
    getModelForGlobalId(globalId) {
      return table.get(globalId)?.modelId ?? null;
    },
  };
}
