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
      const idOffset = resolveIdOffset(store, modelId);
      const meshes = collectMeshes(store, modelId, idOffset);
      const meshIds = new Set(meshes.map(m => m.expressId));
      const ifcConnections = extractConnections(store, modelId, meshIds);
      const merged = mergeConnections(options.connections, ifcConnections);
      return simulateAsync(meshes, toEngineOptions(options, merged));
    },
  };
}

function resolveIdOffset(store: StoreApi, requested: string | null): number {
  const state = store.getState();
  const targetId = requested ?? LEGACY_MODEL_ID;
  const model = state.models.get(targetId);
  return model?.idOffset ?? 0;
}

function collectMeshes(
  store: StoreApi,
  requested: string | null,
  idOffset: number,
): PhysicsMesh[] {
  const state = store.getState();
  const targetId = requested ?? LEGACY_MODEL_ID;
  const result: PhysicsMesh[] = [];

  const model = state.models.get(targetId);
  const geometry = model?.geometryResult ?? state.geometryResult;
  if (!geometry) return result;

  for (const m of geometry.meshes) {
    if (!m.positions || m.positions.length < 9) continue;
    if (!m.indices || m.indices.length < 3) continue;
    result.push({
      // Federated meshes carry global ids; convert back to local so physics,
      // the relationship graph, and SDK callers all share one id space.
      expressId: m.expressId - idOffset,
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
  requested: string | null,
  meshIds: Set<number>,
): Array<[number, number]> {
  const state = store.getState();
  const targetId = requested ?? LEGACY_MODEL_ID;
  const model = state.models.get(targetId);
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
    gravity: options.gravity,
    durationSeconds: options.durationSeconds,
    timeStep: options.timeStep,
    adjacencyTolerance: options.adjacencyTolerance,
    fallThreshold: options.fallThreshold,
    tiltThreshold: options.tiltThreshold,
    groundAnchorTolerance: options.groundAnchorTolerance,
    anchorIfcTypes: options.anchorIfcTypes,
    colliderStrategy: options.colliderStrategy,
    // The viewer always wants playback by default — caller can override.
    captureTrajectory: options.captureTrajectory ?? true,
    trajectoryStride: options.trajectoryStride,
  };
}
