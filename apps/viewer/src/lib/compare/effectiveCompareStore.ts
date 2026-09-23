/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The store Compare fingerprints for a model: the model as the user has edited
 * it, not the file as it was loaded (#5214 finding 2, #5312, charter #5249).
 *
 * Compare's data channel reads the parsed store everywhere. Entity membership
 * comes from `comparableProductIds`, and names, psets, quantities, types,
 * materials and classifications come from `buildDataInput`'s extractors. The
 * mutation overlay never writes into that store. Its geometry channel is live,
 * because `removeEntity` prunes the deleted element's mesh. So an edited model
 * compared as two halves that disagree: a deleted wall lost its mesh but was
 * still fingerprinted, a renamed or re-psetted element read its pre-edit
 * values, and an element created this session was not compared at all.
 *
 * Fixing that one extractor at a time would thread the overlay through a dozen
 * readers, each a new place to forget. Instead this bakes the overlay the way
 * `MergedExporter.exportAsync` does: export the model with its mutations
 * applied and re-parse the bytes. Every Compare read then answers for the
 * effective model by construction. The exporter keeps every source express id,
 * and a created entity keeps its overlay id, so the model's meshes (keyed by
 * id plus the model's offset) still pair with the right fingerprints.
 *
 * A model with no pending edits returns its own store unchanged, so the bake
 * costs nothing on the common path. When there are edits it is one
 * export-and-parse per compared model per run, O(model). That is the price of
 * an answer that cannot miss an overlay read.
 */

import { StepExporter } from '@ifc-lite/export';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { FederatedModel, SchemaVersion } from '@/store/types';
import { resolveEnergyExportMutationSource } from '@/components/viewer/energy-export-source';

export async function effectiveCompareStore(
  store: IfcDataStore,
  mutationView: MutablePropertyView | null,
  schemaVersion: SchemaVersion,
): Promise<IfcDataStore> {
  // Same "does this view carry real edits" rule every other bake in the
  // viewer uses. A registered-but-untouched view is the common case.
  const source = resolveEnergyExportMutationSource({ mutationView, dataStore: store, schemaVersion });
  if (!source) return store;
  const exported = new StepExporter(source.dataStore, source.mutationView).export({
    schema: source.dataStore.schemaVersion,
    applyMutations: true,
    includeGeometry: true,
    includeQuantities: true,
  });
  // slice() yields an exact-length ArrayBuffer-backed copy for the parser.
  return new IfcParser().parseColumnar(exported.content.slice().buffer, { disableWorkerScan: true });
}

/**
 * Both sides of a comparison as edited, plus the baked stores keyed by model
 * id (only for a model that had edits), which post-run readers use through
 * `modelsAsCompared`.
 */
export async function effectiveComparePair(
  base: readonly [FederatedModel, IfcDataStore],
  head: readonly [FederatedModel, IfcDataStore],
  getMutationView: (modelId: string) => MutablePropertyView | null,
): Promise<{
  baseEffective: IfcDataStore;
  headEffective: IfcDataStore;
  comparedStores: Map<string, IfcDataStore>;
}> {
  const comparedStores = new Map<string, IfcDataStore>();
  const bake = async ([model, store]: readonly [FederatedModel, IfcDataStore]): Promise<IfcDataStore> => {
    const effective = await effectiveCompareStore(store, getMutationView(model.id), model.schemaVersion);
    if (effective !== store) comparedStores.set(model.id, effective);
    return effective;
  };
  const baseEffective = await bake(base);
  const headEffective = await bake(head);
  return { baseEffective, headEffective, comparedStores };
}
