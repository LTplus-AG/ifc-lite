/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Physics adapter — bridges the viewer's geometry store to `@ifc-lite/physics`.
 *
 * Pulls every loaded mesh, hands them to Rapier (via the JS WASM build), runs
 * the simulation synchronously, and returns the result. The transport boundary
 * never sees raw geometry; it only sees the small SimulationResult JSON.
 *
 * `init()` from `@ifc-lite/physics` must be awaited at app startup before the
 * first simulate() call. The viewer kicks that off during boot.
 */

import {
  simulate,
  type PhysicsMesh,
  type SimulateOptions,
} from '@ifc-lite/physics';
import type {
  PhysicsBackendMethods,
  PhysicsSimulateOptions,
  PhysicsSimulationResult,
} from '@ifc-lite/sdk';

import type { StoreApi } from './types.js';
import { LEGACY_MODEL_ID } from './model-compat.js';

export function createPhysicsAdapter(store: StoreApi): PhysicsBackendMethods {
  return {
    simulate(modelId: string | null, options: PhysicsSimulateOptions): PhysicsSimulationResult {
      const meshes = collectMeshes(store, modelId);
      return simulate(meshes, toEngineOptions(options));
    },
  };
}

function collectMeshes(store: StoreApi, requested: string | null): PhysicsMesh[] {
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
      expressId: m.expressId,
      ifcType: m.ifcType ?? 'IfcBuildingElement',
      positions: m.positions,
      indices: m.indices,
    });
  }
  return result;
}

function toEngineOptions(options: PhysicsSimulateOptions): SimulateOptions {
  // PhysicsSimulateOptions and SimulateOptions are structurally identical —
  // this is a typed pass-through that keeps the SDK and engine packages
  // independently versionable.
  return {
    remove: options.remove,
    anchor: options.anchor,
    gravity: options.gravity,
    durationSeconds: options.durationSeconds,
    timeStep: options.timeStep,
    adjacencyTolerance: options.adjacencyTolerance,
    fallThreshold: options.fallThreshold,
    tiltThreshold: options.tiltThreshold,
    groundAnchorTolerance: options.groundAnchorTolerance,
    anchorIfcTypes: options.anchorIfcTypes,
  };
}
