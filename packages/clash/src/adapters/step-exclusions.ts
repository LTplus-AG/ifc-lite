/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Void/host/assembly pair exclusions from IFC relationships, precomputed by
 * `elementsFromStep` (`./step.ts`) and re-exported from that module's
 * `@ifc-lite/clash/step` subpath — split out here purely to keep `step.ts`
 * under its module-size budget. `buildStepExclusions` only ever runs against
 * the `byExpressId` map `elementsFromStep` builds, so it stays a sibling of
 * that function rather than a general-purpose export.
 */

import { type IfcDataStore } from '@ifc-lite/parser';
import { EntityNode } from '@ifc-lite/query';
import { makeExclusionSet, qualifiedKey } from '../exclude.js';
import type { ClashElement, ExclusionSet } from '../types.js';

/**
 * Pair-exclusions from IFC relationships. Only relationship getters
 * (`voids`/`filledBy`/`decomposedBy`/`decomposes`) are used here; these read
 * the relationship graph and never call `extractEntityAttributesOnDemand`, so
 * the per-element loop stays off the AGENTS.md hot-loop anti-pattern:
 * - host vs the filler of its opening (wall vs door/window)
 * - element vs its own (meshed) opening
 * - members of the same `IfcRelAggregates` assembly
 */
export function buildStepExclusions(
  store: IfcDataStore,
  byExpressId: Map<number, ClashElement[]>,
): ExclusionSet {
  const pairs: Array<[string, string]> = [];

  for (const [expressId, elementsAtId] of byExpressId) {
    const node = new EntityNode(store, expressId);

    // A relationship is stated between EXPRESS ids, not occurrences: fan it
    // out across every occurrence bucketed at each side (usually one element
    // each; more than one only for a GPU-instanced expressId), so a host's
    // void/assembly exclusions cover every physical placement of the
    // filler/sibling, not just whichever occurrence happened to be built last.
    const pairAll = (otherId: number): void => {
      const others = byExpressId.get(otherId);
      if (!others) return;
      for (const a of elementsAtId) {
        const ek = qualifiedKey(a.model, a.key);
        for (const b of others) {
          pairs.push([ek, qualifiedKey(b.model, b.key)]);
        }
      }
    };

    for (const opening of node.voids()) {
      pairAll(opening.expressId);
      for (const filler of opening.filledBy()) {
        pairAll(filler.expressId);
      }
    }

    const parent = node.decomposedBy();
    if (parent) {
      for (const sibling of parent.decomposes()) {
        if (sibling.expressId === expressId) continue;
        pairAll(sibling.expressId);
      }
    }
  }

  return makeExclusionSet(pairs);
}
