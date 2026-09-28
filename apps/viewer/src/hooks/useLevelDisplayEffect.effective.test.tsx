/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useEffect, useMemo, useRef } from 'react';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { currentLevelYForModels, placeNewMeshesAtCurrentLevel } from '@/lib/level-arrival';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { cleanup, render } from '@/test/render';
import {
  FIXTURE_REL_CONTAINED_2,
  FIXTURE_BUILDING,
  FIXTURE_STOREY_1,
  FIXTURE_STOREY_2,
  FIXTURE_WALL_B,
  FIXTURE_WALL_C,
  guid,
  parseFixtureModel,
} from '@/components/viewer/anonymized-export/anonymized-export-fixture.test-support';
import { useLevelDisplayEffect } from './useLevelDisplayEffect.js';

const OFFSET = 1_000_000;

function geometryOf(ids: number[]): GeometryResult {
  return {
    meshes: ids.map((expressId): MeshData => ({
      expressId,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array(9),
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 1, 1, 1],
      origin: [0, 0, 0],
    } as MeshData)),
    totalTriangles: ids.length,
    totalVertices: ids.length * 3,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      hasLargeCoordinates: false,
    },
  };
}

function LevelEffect({
  onGeometryUpdate,
}: {
  onGeometryUpdate?: (modelId: string, meshes: MeshData[], currentLevelY: ReadonlyMap<number, number>) => void;
} = {}) {
  useLevelDisplayEffect();
  const models = useViewerStore((state) => state.models);
  const applied = useViewerStore((state) => state.appliedEntityLevelOffsets);
  const currentLevelY = useMemo(() => currentLevelYForModels(models, applied), [models, applied]);
  const lastGeometry = useRef(new Map<string, GeometryResult>());
  useEffect(() => {
    for (const [modelId, model] of models) {
      const geometry = model.geometryResult;
      if (!geometry || lastGeometry.current.get(modelId) === geometry) continue;
      lastGeometry.current.set(modelId, geometry);
      onGeometryUpdate?.(modelId, geometry.meshes, currentLevelY);
    }
  }, [models, currentLevelY, onGeometryUpdate]);
  return null;
}

describe('Exploded level display with spatial edits (#5249)', () => {
  afterEach(() => cleanup());

  it('reverses the lift of moved products without a gap or storey-offset change', async () => {
    const store = await parseFixtureModel();
    const model = { ...fixtureModel('m', { idOffset: OFFSET }), ifcDataStore: store,
      geometryResult: geometryOf([OFFSET + FIXTURE_WALL_B, OFFSET + FIXTURE_WALL_C]), maxExpressId: 88 };
    const view = new MutablePropertyView(store.properties, model.id);
    useViewerStore.setState({
      ...fixtureModels(model),
      mutationViews: new Map([[model.id, view]]),
      mutationVersion: 0,
      levelDisplayMode: 'exploded',
      explodedGap: 5,
      appliedStoreyOffsets: new Map(),
      appliedEntityLevelOffsets: new Map(),
      pendingMeshTranslations: null,
    });
    render(<LevelEffect />);
    const initial = useViewerStore.getState().pendingMeshTranslations;
    assert.deepEqual(initial?.get(OFFSET + FIXTURE_WALL_B), [0, 2, 0]);
    assert.deepEqual(initial?.get(OFFSET + FIXTURE_WALL_C), [0, 2, 0]);
    const oldStoreySnapshot = useViewerStore.getState().appliedStoreyOffsets;

    act(() => {
      useViewerStore.getState().clearPendingMeshTranslations();
      view.setAttribute(FIXTURE_REL_CONTAINED_2, 'RelatingStructure', `#${FIXTURE_STOREY_1}`);
      useViewerStore.setState({ mutationVersion: 1 });
    });
    const moved = useViewerStore.getState();
    assert.deepEqual(moved.pendingMeshTranslations?.get(OFFSET + FIXTURE_WALL_B), [0, -2, 0]);
    assert.deepEqual(moved.pendingMeshTranslations?.get(OFFSET + FIXTURE_WALL_C), [0, -2, 0]);
    assert.equal(moved.appliedStoreyOffsets, oldStoreySnapshot,
      'per-storey offsets stayed equal; membership alone caused the renderer update');

    act(() => {
      useViewerStore.getState().clearPendingMeshTranslations();
      view.setAttribute(FIXTURE_REL_CONTAINED_2, 'RelatingStructure', `#${FIXTURE_STOREY_2}`);
      useViewerStore.setState({ mutationVersion: 2 });
    });
    assert.deepEqual(useViewerStore.getState().pendingMeshTranslations?.get(OFFSET + FIXTURE_WALL_B), [0, 2, 0]);

    act(() => {
      useViewerStore.getState().clearPendingMeshTranslations();
      view.setAttribute(FIXTURE_STOREY_2, 'Elevation', '8');
      useViewerStore.setState({ mutationVersion: 3 });
    });
    assert.deepEqual(useViewerStore.getState().pendingMeshTranslations?.get(OFFSET + FIXTURE_WALL_B), [0, -5, 0],
      'the edited elevation changes the live level offset');
  });

  it('lifts authored products and spaces, then reverts a deleted storey', async () => {
    const store = await parseFixtureModel();
    const model = { ...fixtureModel('m', { idOffset: OFFSET }), ifcDataStore: store, maxExpressId: 88 };
    const view = new MutablePropertyView(store.properties, model.id);
    view.setExpressIdWatermark(88);
    const storey = view.createEntity('IfcBuildingStorey', [
      guid(89), null, 'Authored level', null, null, null, null, null, '.ELEMENT.', 6,
    ]);
    view.createEntity('IfcRelAggregates', [
      guid(90), null, null, null, `#${FIXTURE_BUILDING}`, [`#${storey.expressId}`],
    ]);
    const wall = view.createEntity('IfcWall', [guid(91), null, 'Authored wall', null, null, null, null, null]);
    view.createEntity('IfcRelContainedInSpatialStructure', [
      guid(92), null, null, null, [`#${wall.expressId}`], `#${storey.expressId}`,
    ]);
    const space = view.createEntity('IfcSpace', [guid(93), null, 'Authored space', null, null, null, null, null, '.ELEMENT.']);
    view.createEntity('IfcRelAggregates', [
      guid(94), null, null, null, `#${storey.expressId}`, [`#${space.expressId}`],
    ]);
    const meshedModel = { ...model, geometryResult: geometryOf([OFFSET + wall.expressId, OFFSET + space.expressId]) };
    useViewerStore.setState({
      ...fixtureModels(meshedModel),
      mutationViews: new Map([[model.id, view]]),
      mutationVersion: 1,
      levelDisplayMode: 'exploded',
      explodedGap: 5,
      appliedStoreyOffsets: new Map(),
      appliedEntityLevelOffsets: new Map(),
      pendingMeshTranslations: null,
    });
    render(<LevelEffect />);
    assert.deepEqual(useViewerStore.getState().pendingMeshTranslations?.get(OFFSET + wall.expressId), [0, 4, 0]);
    assert.deepEqual(useViewerStore.getState().pendingMeshTranslations?.get(OFFSET + space.expressId), [0, 4, 0]);

    act(() => {
      useViewerStore.getState().clearPendingMeshTranslations();
      view.deleteEntity(storey.expressId);
      useViewerStore.setState({ mutationVersion: 2 });
    });
    assert.deepEqual(useViewerStore.getState().pendingMeshTranslations?.get(OFFSET + wall.expressId), [0, -4, 0]);
    assert.deepEqual(useViewerStore.getState().pendingMeshTranslations?.get(OFFSET + space.expressId), [0, -4, 0]);
  });

  it('waits for a streamed or authored mesh before recording its lift', async () => {
    const store = await parseFixtureModel();
    const model = { ...fixtureModel('m', { idOffset: OFFSET }), ifcDataStore: store,
      geometryResult: geometryOf([]), maxExpressId: 88 };
    useViewerStore.setState({
      ...fixtureModels(model), mutationViews: new Map(), mutationVersion: 0,
      levelDisplayMode: 'exploded', explodedGap: 5,
      appliedStoreyOffsets: new Map(), appliedEntityLevelOffsets: new Map(),
      pendingMeshTranslations: null,
    });
    render(<LevelEffect />);
    assert.equal(useViewerStore.getState().pendingMeshTranslations, null);
    assert.equal(useViewerStore.getState().appliedEntityLevelOffsets.size, 0);

    act(() => {
      const models = new Map(useViewerStore.getState().models);
      models.set('m', { ...model, geometryResult: geometryOf([OFFSET + FIXTURE_WALL_B]) });
      useViewerStore.setState({ models });
    });
    assert.deepEqual(useViewerStore.getState().pendingMeshTranslations?.get(OFFSET + FIXTURE_WALL_B), [0, 2, 0]);
  });

  it('pre-lifts replacement geometry once without queuing a duplicate entity delta', async () => {
    const store = await parseFixtureModel();
    const model = { ...fixtureModel('m', { idOffset: OFFSET }), ifcDataStore: store,
      geometryResult: geometryOf([OFFSET + FIXTURE_WALL_B]), maxExpressId: 88 };
    const arrivals: MeshData[][] = [];
    const onGeometryUpdate = (_modelId: string, meshes: MeshData[], currentLevelY: ReadonlyMap<number, number>) => {
      arrivals.push(placeNewMeshesAtCurrentLevel(meshes, currentLevelY));
    };
    useViewerStore.setState({
      ...fixtureModels(model), mutationViews: new Map(), mutationVersion: 0,
      levelDisplayMode: 'exploded', explodedGap: 5,
      appliedStoreyOffsets: new Map(), appliedEntityLevelOffsets: new Map(),
      pendingMeshTranslations: null,
    });
    render(<LevelEffect onGeometryUpdate={onGeometryUpdate} />);
    assert.deepEqual(useViewerStore.getState().pendingMeshTranslations?.get(OFFSET + FIXTURE_WALL_B), [0, 2, 0]);
    const originalArrivalCount = arrivals.length;

    act(() => {
      useViewerStore.getState().clearPendingMeshTranslations();
      const models = new Map(useViewerStore.getState().models);
      const replacementGeometry = geometryOf([OFFSET + FIXTURE_WALL_B]);
      models.set('m', { ...model, geometryResult: replacementGeometry });
      useViewerStore.setState({ models });
    });
    const replacementArrival = arrivals.at(-1)?.[0];
    assert.ok(arrivals.length > originalArrivalCount, 'the mounted streaming observer sees the replacement geometry');
    assert.deepEqual(replacementArrival?.origin, [0, 2, 0], 'the replacement is born at the existing lift');
    assert.equal(useViewerStore.getState().pendingMeshTranslations, null,
      'the applied snapshot credits the pre-lift so the entity does not get lifted twice');
  });
});
