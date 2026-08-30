/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Expands an `IfcRelAggregates` container ref (an `IfcElementAssembly`, an
 * `IfcStair`/`IfcRoof` used as a container, a wall with
 * `IfcBuildingElementPart`s, …) into itself plus every decomposition
 * descendant, so the id set reaching the viewer includes the parts that
 * actually carry the rendered mesh. Split out of `viewer.ts` so that file
 * stays under its module-size budget.
 *
 * `packages/viewer`'s renderer (`viewer-html.ts`) keys `colorizeEntities` /
 * `isolateEntities` / `hideEntities` / `showEntities` off `entityMap`, which
 * is populated only from rendered mesh batches — a container id is never a
 * key in it. `isolateEntities` in particular dims every id NOT in the
 * requested set, so an unexpanded, geometry-less container id there dims the
 * whole model (issue #3338); `hide`/`show`/`colorize` on an unexpanded
 * container id are quieter, silent no-ops for the same reason.
 *
 * Unlike `apps/viewer`'s `expandToGeometryBearingIds`, this does not filter
 * descendants by whether they actually rendered — packages/mcp runs
 * server-side and has no view into which ids the browser's WASM mesher
 * produced meshes for, only the parser's per-type `hasGeometry` flag, which
 * is a coarse "this type is normally a product" bit (`IfcElementAssembly`
 * itself reads `hasGeometry === true` there, via the `IfcElement` supertype
 * catch-all, even with zero representation of its own — verified against a
 * parsed fixture, not assumed). Passing the full descendant closure through
 * unfiltered is safe: an id the renderer never keyed is simply absent from
 * `entityMap`, so `isolateEntities`'s per-key loop never visits it and
 * `hide`/`show`/`colorize` set a `colorOverrides` entry nothing ever reads.
 * A ref that decomposes nothing passes through unchanged (a plain
 * `IfcWall` global_id is a no-op here); an explicit ref for both a
 * container and one of its own descendants collapses to one entry via the
 * express-id dedup below rather than double-expanding.
 */

import { collectAggregatedDescendants } from '@ifc-lite/data';
import type { EntityRef } from '@ifc-lite/sdk';

/** The narrow slice of `LoadedModel` this helper needs. */
export interface AssemblyExpansionModel {
  id: string;
  store: { relationships: Parameters<typeof collectAggregatedDescendants>[0] };
}

export function expandAssemblyRefs(m: AssemblyExpansionModel, refs: EntityRef[]): EntityRef[] {
  const out: EntityRef[] = [];
  const emitted = new Set<number>();
  const push = (expressId: number) => {
    if (emitted.has(expressId)) return;
    emitted.add(expressId);
    out.push({ modelId: m.id, expressId });
  };
  for (const ref of refs) {
    if (ref.modelId !== m.id) {
      // Defensive: resolveTargetRefs only ever produces same-model refs
      // today, but don't silently drop a foreign ref if that changes.
      out.push(ref);
      continue;
    }
    push(ref.expressId);
    for (const descendant of collectAggregatedDescendants(m.store.relationships, ref.expressId)) {
      push(descendant);
    }
  }
  return out;
}
