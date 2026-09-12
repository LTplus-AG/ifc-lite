/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the Share dialog puts into a room (#4444).
 *
 * With several models loaded the dialog used to seed the ACTIVE model and
 * say nothing: the workspace on screen was a federation, the room was one
 * file. The scope is now explicit — `'active'` shares the active model only,
 * `'all'` shares every loaded model, each in its own room slot — and this
 * module turns that choice into the per-model seed list `startCollab`
 * consumes, reading each model's OWN store and meshes off its record rather
 * than the top-level active-model handles.
 */

import type { FederatedModel } from '@/store/types';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcParser } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { prepareAppearanceSerialization } from '@/lib/appearance/serialization';
import { mapStepSchema } from '@/lib/export/artifact-naming';
import { packagePortableIfcAsync } from '@/lib/export/portable-ifc';
import type { CollabSeedInput, CollabSeedModel } from './owner-seed';

const MAX_PORTABLE_STEP_SOURCE_BYTES = 96 * 1024 * 1024;

function assertPortableSourceSize(bytes: { byteLength: number }): void {
  if (bytes.byteLength > MAX_PORTABLE_STEP_SOURCE_BYTES) {
    throw new Error('The portable IFC source exceeds the 96 MiB room-source limit. Export it locally or share a smaller model.');
  }
}

export type ShareScope = 'active' | 'all';

/** The dialog offers a choice only when there is one to make. */
export function shareScopeIsChoice(models: ReadonlyMap<string, FederatedModel>): boolean {
  return models.size > 1;
}

/**
 * The models a share of `scope` covers, in the order the room will slot
 * them: the active model first, then the rest in load order. Models with no
 * parsed store (a GLB, a point cloud, a load still in flight) have nothing to
 * seed and are left out.
 */
export function modelsInShareScope(
  models: ReadonlyMap<string, FederatedModel>,
  activeModelId: string | null,
  scope: ShareScope,
): FederatedModel[] {
  const active = activeModelId ? models.get(activeModelId) : undefined;
  if (scope === 'active') {
    const only = active ?? models.values().next().value;
    return only ? [only] : [];
  }
  const rest = Array.from(models.values()).filter((m) => m !== active);
  return active ? [active, ...rest] : rest;
}

/**
 * Build the seed `startCollab` consumes. ALWAYS a seed, even an empty one:
 * `startCollab` tells an owner from a recipient by the presence of `seed`,
 * so an owner with nothing seedable (the only model still loading, a GLB or
 * point-cloud workspace, the last model removed mid-mint) must still take
 * the owner path — an empty scope settles 'ready' and every room-model
 * resolver fails closed — rather than reconstruct its own empty room as a
 * ghost 'Shared model' and count itself a joiner of it.
 */
export function buildShareSeed(
  models: ReadonlyMap<string, FederatedModel>,
  activeModelId: string | null,
  scope: ShareScope,
): CollabSeedInput {
  const seedModels: CollabSeedModel[] = [];
  for (const m of modelsInShareScope(models, activeModelId, scope)) {
    const store = m.ifcDataStore;
    if (!store) continue;
    const isIfcx = (m.schemaVersion ?? store.schemaVersion) === 'IFC5';
    seedModels.push({
      modelId: m.id,
      name: m.name,
      store,
      isIfcx,
      // Legacy STEP seeds the meshes the viewer already tessellated; an IFCX
      // model re-parses its own bytes at seed time (see owner-seed.ts).
      meshes: isIfcx ? null : (m.geometryResult?.meshes ?? null),
      idOffset: m.idOffset,
      schemaVersion: m.schemaVersion,
      fileName: m.name,
      sourceFingerprint: m.sourceFingerprint,
    });
  }
  return { models: seedModels };
}

/**
 * Build a room seed from the effective authored model. STEP mutations live in
 * an overlay until export; sharing that base store would omit newly created
 * IfcAnnotation roots and every representation row they own. Materialize and
 * reparse changed models once, then let the existing seed path use that
 * self-consistent store/id space for both entity paths and meshes.
 */
export async function prepareShareSeed(
  models: ReadonlyMap<string, FederatedModel>,
  mutationViews: ReadonlyMap<string, MutablePropertyView>,
  activeModelId: string | null,
  scope: ShareScope,
): Promise<CollabSeedInput> {
  const seed = buildShareSeed(models, activeModelId, scope);
  for (const item of seed.models) {
    if (item.isIfcx) continue;
    const view = mutationViews.get(item.modelId);
    if (view && view.getModifiedEntityCount() > 0) {
      const serialized = prepareAppearanceSerialization(item.modelId, item.store, view);
      const result = await new StepExporter(item.store, serialized.view).exportAsync({
        schema: mapStepSchema(item.schemaVersion ?? item.store.schemaVersion),
        includeGeometry: true,
        applyMutations: true,
        visibleOnly: false,
        application: 'ifc-lite',
      });
      const bytes = result.content.slice();
      const liveStore = item.store;
      item.store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer);
      item.liveStore = liveStore;
      if ((item.store.entityIndex.byType.get('IFCANNOTATION')?.length ?? 0) > 0) {
        assertPortableSourceSize(bytes);
        const artifact = await packagePortableIfcAsync(item.modelId, bytes, serialized.resources);
        item.portableStepSource = typeof artifact.content === 'string'
          ? new TextEncoder().encode(artifact.content)
          : artifact.content;
        item.portableStepSourceFormat = artifact.ext === 'ifczip' ? 'ifczip' : 'step';
      }
      continue;
    }
    // Preserve native symbolic rows for an unchanged IFC that already carries
    // annotations. Ordinary models keep the lighter root-only room snapshot.
    if ((item.store.entityIndex.byType.get('IFCANNOTATION')?.length ?? 0) > 0) {
      assertPortableSourceSize(item.store.source);
      const serialized = prepareAppearanceSerialization(item.modelId, item.store, undefined);
      const artifact = await packagePortableIfcAsync(
        item.modelId, item.store.source.materialize().slice(), serialized.resources,
      );
      item.portableStepSource = typeof artifact.content === 'string'
        ? new TextEncoder().encode(artifact.content)
        : artifact.content;
      item.portableStepSourceFormat = artifact.ext === 'ifczip' ? 'ifczip' : 'step';
    }
  }
  return seed;
}
