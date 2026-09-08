/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the to-scale 3D-view PDF (#2042) is allowed to draw.
 *
 * The two defect classes these tests exist for:
 *  - **#2558 / #2576, half a model.** GPU-instanced occurrences are absent
 *    from `geometryResult.meshes`; the Cesium world view read that list
 *    straight and silently dropped more than half the model. Deleting the
 *    instanced append in `collectViewMeshes` must turn a test here red.
 *  - **A partial visibility fold.** Five independent channels decide what is
 *    on screen. Dropping any one of them prints elements the viewport is not
 *    showing, and the PDF still looks like a plausible drawing — so each
 *    channel gets a test that fails on its own.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MeshData } from '@ifc-lite/geometry';
import { collectViewMeshes, type ViewMeshInput } from './collect-view-meshes.js';

function mesh(expressId: number, extra: Partial<MeshData> = {}): MeshData {
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
    ...extra,
  };
}

const ALL_TYPES_ON = {
  spaces: true,
  spatialZones: true,
  openings: true,
  virtualElements: true,
  site: true,
  ifcAnnotations: true,
};

function input(overrides: Partial<ViewMeshInput> = {}): ViewMeshInput {
  return {
    meshes: [
      mesh(1, { ifcType: 'IfcWall', modelIndex: 0 }),
      mesh(2, { ifcType: 'IfcSpace', modelIndex: 0 }),
      mesh(3, { ifcType: 'IfcSlab', modelIndex: 0 }),
    ],
    instancedMeshes: [],
    hiddenEntities: null,
    isolatedEntities: null,
    computedIsolatedIds: null,
    typeVisibility: ALL_TYPES_ON,
    modelVisibility: null,
    ...overrides,
  };
}

const ids = (meshes: readonly MeshData[]): number[] => meshes.map((m) => m.expressId).sort((a, b) => a - b);

describe('collectViewMeshes', () => {
  it('keeps everything when no channel is filtering', () => {
    assert.deepEqual(ids(collectViewMeshes(input())), [1, 2, 3]);
  });

  it('drops a hidden entity', () => {
    const out = collectViewMeshes(input({ hiddenEntities: new Set([2]) }));

    assert.deepEqual(ids(out), [1, 3]);
  });

  it('keeps only the isolated set', () => {
    const out = collectViewMeshes(input({ isolatedEntities: new Set([3]) }));

    assert.deepEqual(ids(out), [3]);
  });

  it('lets the computed (storey/class) isolation win over the store set', () => {
    // `effectiveIsolatedIds`: the viewport hands the renderer the computed set,
    // so an export resolving the store set instead would print the storeys the
    // screen has isolated away.
    const out = collectViewMeshes(
      input({ computedIsolatedIds: new Set([1]), isolatedEntities: new Set([1, 2, 3]) }),
    );

    assert.deepEqual(ids(out), [1]);
  });

  it('hides everything for an EMPTY computed isolation set', () => {
    // "the filter matched nothing" is an isolation state, not an absent one.
    const out = collectViewMeshes(input({ computedIsolatedIds: new Set<number>() }));

    assert.deepEqual(ids(out), []);
  });

  it('keeps hiding an entity that is also isolated', () => {
    const out = collectViewMeshes(
      input({ hiddenEntities: new Set([1]), isolatedEntities: new Set([1, 3]) }),
    );

    assert.deepEqual(ids(out), [3]);
  });

  it('drops the IfcSpace mesh when typeVisibility.spaces is off (#2060)', () => {
    const out = collectViewMeshes(
      input({ typeVisibility: { ...ALL_TYPES_ON, spaces: false } }),
    );

    assert.deepEqual(ids(out), [1, 3]);
  });

  it("drops a federated model's meshes when that model is not visible", () => {
    const federated = input({
      meshes: [
        mesh(1, { ifcType: 'IfcWall', modelIndex: 0 }),
        mesh(1_000_001, { ifcType: 'IfcWall', modelIndex: 1 }),
        mesh(1_000_002, { ifcType: 'IfcDoor', modelIndex: 1 }),
      ],
      modelVisibility: new Map([
        [0, true],
        [1, false],
      ]),
    });

    assert.deepEqual(ids(collectViewMeshes(federated)), [1]);
  });

  it('treats a model index absent from the map as visible', () => {
    const out = collectViewMeshes(input({ modelVisibility: new Map([[7, false]]) }));

    assert.deepEqual(ids(out), [1, 2, 3]);
  });

  it('INCLUDES injected instanced meshes (#2558 — half the model otherwise)', () => {
    // Instanced occurrences live in the renderer scene, not in
    // `geometryResult.meshes`. Remove the append in `collectViewMeshes` and
    // this goes red: the facade would silently not print.
    const out = collectViewMeshes(
      input({
        instancedMeshes: [mesh(41), mesh(42), mesh(43)],
      }),
    );

    assert.deepEqual(ids(out), [1, 2, 3, 41, 42, 43]);
  });

  it('filters instanced meshes through hide and isolate exactly like flat ones', () => {
    const out = collectViewMeshes(
      input({
        instancedMeshes: [mesh(41), mesh(42)],
        hiddenEntities: new Set([41, 1]),
      }),
    );

    assert.deepEqual(ids(out), [2, 3, 42]);

    const isolated = collectViewMeshes(
      input({
        instancedMeshes: [mesh(41), mesh(42)],
        isolatedEntities: new Set([42]),
      }),
    );

    assert.deepEqual(ids(isolated), [42]);
  });

  it('keeps instanced meshes out of a hidden model', () => {
    // Shard ids are in the primary model's space (index 0), so hiding the
    // primary model must take its instanced occurrences with it.
    const out = collectViewMeshes(
      input({
        instancedMeshes: [mesh(41), mesh(42)],
        modelVisibility: new Map([[0, false]]),
      }),
    );

    assert.deepEqual(ids(out), []);
  });

  it('does not mutate the caller\'s mesh arrays', () => {
    const flat = [mesh(1, { ifcType: 'IfcWall' })];
    const instanced = [mesh(41)];
    collectViewMeshes(input({ meshes: flat, instancedMeshes: instanced, hiddenEntities: new Set([1]) }));

    assert.equal(flat.length, 1);
    assert.equal(instanced.length, 1);
  });
});
