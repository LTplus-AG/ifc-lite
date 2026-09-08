/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression test for the "federated instanced gap" question left open by
 * #2865 / PR #2878: `withInstancedMeshes` used to refuse to restore
 * GPU-instanced occurrences for any model whose `idOffset !== 0` — i.e.
 * every federated SECONDARY model. #2878's original comment justified this
 * as "shard entity ids are in the primary model's id space, idOffset 0".
 *
 * That was true when this helper was authored (#1238, 2026-06-21, commit
 * e753e96f9): GPU instancing was primary-only at that point
 * (`enableInstancing: target.kind === 'primary'`).
 *
 * It stopped being true on 2026-08-06, PR #2255 ("deliver GPU instancing to
 * federated models", commit 016841f77), which:
 *   - flipped `enableInstancing: true` for EVERY load, primary and federated
 *     (`apps/viewer/src/hooks/useIfcLoader.ts:1260`);
 *   - re-homes a federated shard's raw occurrence `entityId`s onto that
 *     model's GLOBAL id space by `idOffset` at drain time, the SAME offset
 *     `finalizeModel` already applies to that model's flat meshes
 *     (`apps/viewer/src/components/viewer/useGeometryStreaming.ts:812`:
 *     `instance.entityId += idOffset`), before upload
 *     (`scene.addInstancedShard(device, shard, modelIndex)`);
 *   - `Scene.getAllInstancedMeshData()` (`packages/renderer/src/scene.ts:3437`)
 *     iterates `this.instancedEntityMap.keys()` — ALL models' occurrences,
 *     unfiltered by `modelIndex` — and returns their ALREADY-GLOBAL ids.
 *
 * So by the time `withInstancedMeshes` runs, a federated secondary model's
 * instanced occurrences are already in the scene, already in the same
 * global id space and the same world-space frame flat meshes use (no
 * separate alignment transform exists anywhere in this codebase — federation
 * placement is id-space only, via `idOffset`). The gate, not the data, was
 * what was missing.
 *
 * The fix replaces the `isPrimary: boolean` gate with a
 * `modelRange: { idOffset, maxExpressId } | null` id-range filter: since
 * `getAllInstancedMeshData()` returns EVERY loaded model's occurrences
 * unfiltered, a bare "drop the gate" fix would have made every caller that
 * loops per-model (`useClash.ts`'s `gatherElements`, the view-PDF export
 * source) splice every OTHER model's instanced entities into each model's
 * own set too — this test's second case is the calibration proving that
 * does NOT happen.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { RefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { setGlobalRendererRef } from '../hooks/useBCF.js';
import { withInstancedMeshes } from './instancedExport.js';

function flatMesh(expressId: number): MeshData {
  return {
    expressId,
    ifcType: 'IfcWall',
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
  };
}

/** An instanced occurrence at GLOBAL id `expressId` — exactly the shape
 *  `Scene.getAllInstancedMeshData()` returns for ANY model's occurrences,
 *  primary or federated (`scene.ts:3437`, no per-model filter), already
 *  offset into the global id space by `useGeometryStreaming.ts:812` for a
 *  federated model. */
function instancedOccurrence(globalExpressId: number, occSlot: number): MeshData {
  return {
    expressId: globalExpressId,
    ifcType: 'IfcDoor',
    positions: new Float32Array([2, 0, 0, 3, 0, 0, 2, 1, 0]),
    normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]),
    color: [0.5, 0.5, 0.5, 1],
    occurrenceKey: `${globalExpressId}:inst:0:${occSlot}`,
  };
}

function geometryOf(meshes: MeshData[]): GeometryResult {
  return {
    meshes,
    totalTriangles: meshes.length,
    totalVertices: meshes.length * 3,
    coordinateInfo: {} as GeometryResult['coordinateInfo'],
  };
}

function setRenderer(instanced: MeshData[]): void {
  const scene = { getAllInstancedMeshData: () => instanced };
  const fake = { getScene: () => scene } as unknown as Renderer;
  setGlobalRendererRef({ current: fake } as RefObject<Renderer | null>);
}

describe('#2865/#2878 follow-up: federated secondary models and GPU-instanced entities', () => {
  afterEach(() => {
    setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
  });

  it('a federated secondary model\'s own instanced occurrence reaches the geometry set (was silently dropped by the isPrimary gate)', () => {
    // A federated secondary model, e.g. idOffset 100000 assigned by
    // federationRegistry. Its instanced door occurrence has ALREADY been
    // re-homed to the global id space (100000 + local id 7) by
    // useGeometryStreaming.ts:812, exactly as a real federated load does.
    const idOffset = 100_000;
    const maxExpressId = 1_000; // this model's local id space, e.g. 1..1000
    const localDoorId = 7;
    const globalDoorId = idOffset + localDoorId;

    setRenderer([instancedOccurrence(globalDoorId, 0)]);

    const flatOnly = geometryOf([flatMesh(idOffset + 1) /* the secondary model's flat wall */]);

    // This is the call `useClash`'s gatherElements (and every export call
    // site) now makes for ANY model: `withInstancedMeshes(geometryResult,
    // { idOffset: model.idOffset, maxExpressId: model.maxExpressId })`.
    const out = withInstancedMeshes(flatOnly, { idOffset, maxExpressId });

    // The fix: the door is present. Before the fix (the old
    // `isPrimary: idOffset === 0` gate), this assertion failed — the door was
    // silently absent, the identical symptom #2865 named for the primary
    // model.
    const restored = out.meshes.find((m) => m.expressId === globalDoorId);
    assert.ok(
      restored,
      'a federated secondary model\'s instanced entity, already present in the scene under its ' +
        'correct global id, must reach the geometry set clash/export consume',
    );
    assert.equal(restored?.occurrenceKey, `${globalDoorId}:inst:0:0`);
    // Position untouched — no coordinate-frame transform is needed; the scene
    // already produced world-space, global-id-keyed triangles for this
    // federated occurrence (no separate alignment transform exists in this
    // codebase; federation placement is id-space only).
    assert.deepEqual(Array.from(restored!.positions), [2, 0, 0, 3, 0, 0, 2, 1, 0]);
  });

  it('CALIBRATION: does not adopt a DIFFERENT loaded model\'s instanced occurrence (proves the id-range filter is a real scope, not the gate simply removed)', () => {
    // Two federated models are loaded: the primary (idOffset 0) with its own
    // instanced door, and a secondary at idOffset 100000 with its own
    // instanced door. `getAllInstancedMeshData()` returns BOTH, unfiltered —
    // if the fix were just "drop the isPrimary boolean and always splice in
    // everything", the secondary model's call here would wrongly adopt the
    // primary's door too, double-counting it across the federation.
    const idOffset = 100_000;
    const maxExpressId = 1_000;
    const ownLocalDoorId = 7;
    const ownGlobalDoorId = idOffset + ownLocalDoorId;
    const otherModelsDoorId = 12; // belongs to the primary model, idOffset 0

    setRenderer([instancedOccurrence(ownGlobalDoorId, 0), instancedOccurrence(otherModelsDoorId, 0)]);

    const flatOnly = geometryOf([flatMesh(idOffset + 1)]);
    const out = withInstancedMeshes(flatOnly, { idOffset, maxExpressId });

    assert.ok(
      out.meshes.some((m) => m.expressId === ownGlobalDoorId),
      'this model\'s own instanced door is adopted',
    );
    assert.equal(
      out.meshes.some((m) => m.expressId === otherModelsDoorId),
      false,
      'the OTHER model\'s instanced door, outside this model\'s id-range bracket, is not adopted',
    );
  });
});
