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
import type { CollabSeedInput, CollabSeedModel } from './owner-seed';

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
