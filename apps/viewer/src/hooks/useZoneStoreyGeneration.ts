/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Generate a zone set from storeys" (issue #1810 generation path (b)):
 * one zone per building storey, spanning the model's XY bounds.
 *
 * Storey collection reuses `elevationKey`/`compareStoreyEntries` from the
 * hierarchy tree builder — the SAME 0.5m-tolerance elevation-matching
 * `buildUnifiedStoreys` uses to merge one federated storey across several
 * models into a single row — so "Ground Floor" split across two federated
 * files still yields ONE zone, not two overlapping ones. That function only
 * activates for `models.size > 1`, so this re-implements the same key/merge
 * logic to also cover the single/legacy-model path.
 *
 * The actual box math (spanning storeys → `Zone[]`) is the pure, unit-tested
 * `generateStoreyZones` in `lib/zones`; this module is purely the "gather
 * inputs from the loaded model(s) + renderer" glue, mirroring
 * `useZoneAssignmentSync`'s gather-then-call-the-pure-engine shape.
 */

import { useViewerStore } from '@/store';
import { elevationKey } from '@/components/viewer/hierarchy/treeDataBuilder';
import { getGlobalRenderer } from './useBCF.js';
import { generateStoreyZones, type Zone, type StoreyInfo } from '../lib/zones/index.js';

export type GenerateStoreyZonesResult =
  | { ok: true; zones: Zone[] }
  | { ok: false; error: string };

/** Union of every storey across every loaded model, deduplicated by
 *  elevation (0.5m tolerance). When two models both declare a storey at the
 *  same elevation, the shorter of the two names wins (matches
 *  `buildUnifiedStoreys`' tie-break). */
function collectStoreysAcrossModels(): StoreyInfo[] {
  const state = useViewerStore.getState();
  const byKey = new Map<string, StoreyInfo>();

  const consider = (dataStore: { spatialHierarchy?: { storeyElevations: Map<number, number> } | null; entities: { getName(id: number): string } } | null | undefined) => {
    const hierarchy = dataStore?.spatialHierarchy;
    if (!hierarchy) return;
    for (const [storeyId, elevation] of hierarchy.storeyElevations) {
      const key = elevationKey(elevation);
      const name = dataStore!.entities.getName(storeyId) || `Storey #${storeyId}`;
      const existing = byKey.get(key);
      if (!existing || name.length < existing.name.length) {
        byKey.set(key, { id: key, name, elevation });
      }
    }
  };

  if (state.models.size > 0) {
    for (const [, model] of state.models) consider(model.ifcDataStore);
  } else if (state.ifcDataStore) {
    consider(state.ifcDataStore);
  }

  return Array.from(byKey.values());
}

/**
 * Generate one zone per distinct storey elevation, spanning the union of
 * every loaded model's XY bounds (from the renderer's `Scene`, so it
 * reflects everything currently loaded, federated or legacy single-model).
 */
export function generateZonesFromStoreys(): GenerateStoreyZonesResult {
  const storeys = collectStoreysAcrossModels();
  if (storeys.length === 0) {
    return { ok: false, error: 'No building storeys found in the loaded model(s).' };
  }

  const scene = getGlobalRenderer()?.getScene();
  const bounds = scene?.getBounds();
  if (!bounds) {
    return { ok: false, error: 'Model bounds are not available yet — wait for geometry to finish loading.' };
  }

  const zones = generateStoreyZones(
    storeys,
    { minX: bounds.min.x, maxX: bounds.max.x, minZ: bounds.min.z, maxZ: bounds.max.z },
    () => crypto.randomUUID(),
  );
  return { ok: true, zones };
}
