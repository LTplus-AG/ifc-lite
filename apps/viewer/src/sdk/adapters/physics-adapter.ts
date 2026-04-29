/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Physics adapter — bridges the viewer's geometry store to `@ifc-lite/physics`.
 *
 * Pulls every loaded mesh, extracts caller-relevant IFC connection
 * relationships (`IfcRelConnectsElements`, `IfcRelConnectsPathElements`,
 * `IfcRelConnectsStructuralMember`, `IfcRelConnectsWithRealizingElements`),
 * and hands them to Rapier (via the JS WASM build). The transport boundary
 * never sees raw geometry; it only sees the small SimulationResult JSON.
 *
 * **ID space convention.** Federated `geometryResult.meshes[].expressId` is
 * a *global* id (`localExpressId + idOffset`), but `dataStore.relationships`
 * keys on local express ids and the SDK contract speaks local ids too. We
 * normalize meshes to local ids on the way in so all of physics — `remove`,
 * `anchor`, IFC connections, and the result body ids — stays in one space.
 *
 * `init()` from `@ifc-lite/physics` boots the Rapier WASM module — it's
 * exposed via `bim.physics.ready()` so the UI can gate the trigger
 * affordance until the engine is loaded.
 */

import {
  init as physicsInit,
  simulateAsync,
  type PhysicsMesh,
  type SimulateOptions,
} from '@ifc-lite/physics';
import { RelationshipType } from '@ifc-lite/data';
import type {
  PhysicsBackendMethods,
  PhysicsSimulateOptions,
  PhysicsSimulationResult,
} from '@ifc-lite/sdk';

import type { StoreApi } from './types.js';
import { LEGACY_MODEL_ID } from './model-compat.js';
import { fromGlobalIdFromModels } from '../../store/globalId.js';

const CONNECTION_REL_TYPES = [
  RelationshipType.ConnectsElements,
  RelationshipType.ConnectsPathElements,
  RelationshipType.ConnectsStructuralMember,
  RelationshipType.ConnectsWithRealizingElements,
];

export function createPhysicsAdapter(store: StoreApi): PhysicsBackendMethods {
  return {
    ready(): Promise<void> {
      return physicsInit();
    },
    simulate(
      modelId: string | null,
      options: PhysicsSimulateOptions,
    ): Promise<PhysicsSimulationResult> {
      try {
        const resolved = resolveModelId(store, modelId);
        const meshes = collectMeshes(store, resolved);
        const meshIds = new Set(meshes.map((m) => m.expressId));
        const ifcConnections = extractConnections(store, resolved, meshIds);
        const merged = mergeConnections(options.connections, ifcConnections);
        return simulateAsync(meshes, toEngineOptions(options, merged));
      } catch (err) {
        return Promise.reject(err);
      }
    },
  };
}

/**
 * Resolve the caller's modelId to a known model. Returns the legacy model
 * id when `requested` is null (back-compat with single-model callers).
 * Throws when a non-null id isn't registered — silently falling back to
 * the legacy store would run physics against the wrong geometry.
 */
function resolveModelId(store: StoreApi, requested: string | null): string {
  if (requested === null) return LEGACY_MODEL_ID;
  const state = store.getState();
  if (state.models.has(requested)) return requested;
  // Single-model legacy behavior: if the ONLY model is the legacy store,
  // accept the legacy alias as a no-op.
  if (state.models.size === 0 && requested === LEGACY_MODEL_ID) {
    return requested;
  }
  throw new Error(`physics.simulate: unknown modelId '${requested}'`);
}

function collectMeshes(store: StoreApi, modelId: string): PhysicsMesh[] {
  const state = store.getState();
  const result: PhysicsMesh[] = [];

  const model = state.models.get(modelId);
  const geometry = model?.geometryResult ?? state.geometryResult;
  if (!geometry) return result;

  for (const m of geometry.meshes) {
    if (!m.positions || m.positions.length < 9) continue;
    if (!m.indices || m.indices.length < 3) continue;
    // Federated meshes carry global ids (`localExpressId + idOffset`).
    // Route through the registry helper instead of subtracting `idOffset`
    // ad-hoc — that's the path the rest of the viewer uses.
    const local = fromGlobalIdFromModels(state.models, m.expressId);
    const expressId = local && local.modelId === modelId ? local.expressId : m.expressId;
    result.push({
      expressId,
      ifcType: m.ifcType ?? 'IfcBuildingElement',
      positions: m.positions,
      indices: m.indices,
    });
  }
  return result;
}

/**
 * Pull connection pairs out of the IFC relationship graph. Only edges where
 * both endpoints are present in `meshIds` are kept — physics ignores
 * pairs that reference missing express IDs anyway, but trimming here keeps
 * the result clean for callers that introspect it.
 */
function extractConnections(
  store: StoreApi,
  modelId: string,
  meshIds: Set<number>,
): Array<[number, number]> {
  const state = store.getState();
  const model = state.models.get(modelId);
  const dataStore = model?.ifcDataStore ?? state.ifcDataStore;
  if (!dataStore) return [];

  const seen = new Set<string>();
  const pairs: Array<[number, number]> = [];

  for (const id of meshIds) {
    for (const relType of CONNECTION_REL_TYPES) {
      const targets = dataStore.relationships.getRelated(id, relType, 'forward');
      for (const t of targets) {
        if (!meshIds.has(t)) continue;
        if (id === t) continue;
        const a = id < t ? id : t;
        const b = id < t ? t : id;
        const key = `${a}-${b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

function mergeConnections(
  caller: Array<[number, number]> | undefined,
  ifc: Array<[number, number]>,
): Array<[number, number]> {
  if (!caller || caller.length === 0) return ifc;
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];
  for (const [a, b] of [...caller, ...ifc]) {
    if (a === b) continue;
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = `${lo}-${hi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([lo, hi]);
  }
  return out;
}

function toEngineOptions(
  options: PhysicsSimulateOptions,
  connections: Array<[number, number]>,
): SimulateOptions {
  return {
    remove: options.remove,
    anchor: options.anchor,
    connections,
    // The renderer is Y-up internally (the geometry layer converts IFC's
    // Z-up coordinates during mesh parsing). We feed those Y-up positions
    // straight into physics, so gravity has to point along -Y or bodies
    // get yanked sideways. Caller can still override.
    gravity: options.gravity ?? [0, -9.81, 0],
    durationSeconds: options.durationSeconds,
    timeStep: options.timeStep,
    adjacencyTolerance: options.adjacencyTolerance,
    fallThreshold: options.fallThreshold,
    tiltThreshold: options.tiltThreshold,
    groundAnchorTolerance: options.groundAnchorTolerance,
    anchorIfcTypes: options.anchorIfcTypes,
    excludeIfcTypes: options.excludeIfcTypes,
    colliderStrategy: options.colliderStrategy,
    // The viewer always wants playback by default — caller can override.
    captureTrajectory: options.captureTrajectory ?? true,
    trajectoryStride: options.trajectoryStride,
    debug: options.debug,
  };
}
