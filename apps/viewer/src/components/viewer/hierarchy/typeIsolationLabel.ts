/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import { fromGlobalIdFromModels } from '@/store/globalId';
import type { FederatedModel } from '@/store/types';

/** The subset of `FederatedModel` this helper reads. */
export type TypeIsolationModelMapLike = ReadonlyMap<
  string,
  Pick<FederatedModel, 'idOffset' | 'maxExpressId' | 'ifcDataStore'>
>;

/**
 * Derive the label for a type/group isolation chip (Type tab, or the Filter
 * tab's "Isolate in 3D", #2532): the shared IFC type name when every isolated
 * id resolves to the SAME type, otherwise a bare count.
 *
 * Each id is resolved through `fromGlobalIdFromModels` — the canonical
 * offset-range resolver — before it is looked up. `fromGlobalIdFromModels`
 * only returns `undefined` when there is more than one federated model and
 * the id falls outside every model's offset range (a stale/foreign id); in
 * that case the id is SKIPPED rather than queried against the wrong store
 * with its raw (un-offset) value as an expressId, which could coincidentally
 * hit an unrelated entity and mislabel or falsely "homogenize" the chip
 * (single-model mode never hits this: `fromGlobalIdFromModels` already
 * degrades to `expressId === globalId` internally when there is exactly one
 * model or none).
 */
export function computeTypeIsolationLabel(
  isolatedEntities: ReadonlySet<number> | null,
  models: TypeIsolationModelMapLike,
  fallbackStore: IfcDataStore | null,
): string | null {
  if (!isolatedEntities || isolatedEntities.size === 0) return null;

  let sampleType: string | undefined;
  let homogeneous = true;
  for (const id of isolatedEntities) {
    const loc = fromGlobalIdFromModels(models, id);
    if (!loc) continue;
    const store = models.get(loc.modelId)?.ifcDataStore ?? fallbackStore;
    const type = store?.entities?.getTypeName(loc.expressId);
    if (!type) continue;
    if (sampleType === undefined) {
      sampleType = type;
    } else if (sampleType !== type) {
      homogeneous = false;
      break;
    }
  }
  if (sampleType && homogeneous) return sampleType;
  return `${isolatedEntities.size} elements`;
}
