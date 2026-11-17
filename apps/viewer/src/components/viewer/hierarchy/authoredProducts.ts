/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore, type FederatedModel } from '@/store';
import { makeAssemblyGeometry } from './productTree';
import type { AuthoredProduct } from './treeDataBuilder';

/**
 * Authored (overlay) products that put something on screen. They live in the
 * mutation overlay, not the columnar parse the class/type builders scan, so a
 * baked IfcSpace would be absent from the "By Class" tree. A product qualifies
 * through its own mesh, which keeps this to real products (the space has a
 * mesh; its helper points, placements and solids don't), or through its parts:
 * a curtain wall has no mesh of its own and renders through them (#9026).
 */
export function collectAuthoredProducts(
  mutationViews: ReadonlyMap<string, MutablePropertyView>,
  models: Map<string, FederatedModel>,
  legacyStore: IfcDataStore | null | undefined,
  geometricIds: ReadonlySet<number>,
): AuthoredProduct[] {
  const out: AuthoredProduct[] = [];
  const state = useViewerStore.getState();
  for (const [modelId, view] of mutationViews) {
    const getNew = (view as { getNewEntities?: () => Iterable<{ expressId: number; type: string; attributes: unknown[] }> }).getNewEntities;
    if (typeof getNew !== 'function') continue;
    const store = models.get(modelId)?.ifcDataStore ?? legacyStore;
    const assembly = store ? makeAssemblyGeometry(store, modelId, models, geometricIds, true, view) : null;
    for (const ent of getNew.call(view)) {
      const globalId = modelId === 'legacy' || !models.has(modelId)
        ? ent.expressId
        : state.toGlobalId(modelId, ent.expressId);
      if (!geometricIds.has(globalId) && !assembly?.renders(ent.type, ent.expressId, globalId)) continue;
      const rawName = ent.attributes?.[2];
      out.push({
        modelId,
        expressId: ent.expressId,
        globalId,
        ifcType: ent.type,
        name: typeof rawName === 'string' && rawName ? rawName : `${ent.type} #${ent.expressId}`,
        parts: assembly?.parts(ent.expressId, ent.type),
      });
    }
  }
  return out;
}
