/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Renderer } from '@ifc-lite/renderer';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { appearanceInstanceScene } from '@/test/appearance-instance-scene';
import { sectionNativeGeometry, sectionIndexedBounds, sourceDigest } from '@/test/section-native-geometry';
import { applyFederationOffsetToMesh } from '@/hooks/ingest/federationOffset';
import { applyFederationOffsetToShard } from '@/components/viewer/useGeometryStreaming';
import { getGlobalRenderer, setGlobalRendererRef } from '@/hooks/useBCF';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { emptyPlacementState, beginPlacement, previewPlacement, commitPlacement } from '@/lib/model-placement/state';
import { isMeshVisibleInViewMode, meshClassIsPlaced } from '@/lib/type-view-visibility';
import { placementCoordinateInfo } from './placement-coordinate-info';

for (const count of [1, 2]) it(`#7525: complete native section extents precede the first move (${count} models)`, t => {
  const first = sectionNativeGeometry(t); if (!first) return;
  const previous = getGlobalRenderer();
  const renderer = new Renderer(document.createElement('canvas')), scene = renderer.getScene();
  const allocation = appearanceInstanceScene([]);
  const models = new Map<string, FederatedModel>(), owners = new Map<string, number[]>();
  const sources = [first];
  useViewerStore.getState().clearAllModels(); modelIndices(new Map());
  try {
    for (let i = 0; i < count; i++) {
      const native: ReturnType<typeof sectionNativeGeometry> = i === 0 ? first : sectionNativeGeometry(t); assert.ok(native);
      if (i > 0) sources.push(native);
      const id = `native-${i}`;
      const maxId = Math.max(...native.meshes.map(mesh => mesh.expressId), ...native.shard.instances.map(instance => instance.entityId));
      const offset = useViewerStore.getState().registerModelOffset(id, maxId);
      for (const mesh of native.meshes) { applyFederationOffsetToMesh(mesh, offset); mesh.modelIndex = i; }
      applyFederationOffsetToShard(native.shard, offset);
      models.set(id, { ...fixtureModel(id, { idOffset: offset }), maxExpressId: maxId,
        geometryResult: { meshes: native.meshes, coordinateInfo: native.coordinateInfo,
          totalTriangles: native.meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0),
          totalVertices: native.meshes.reduce((sum, mesh) => sum + mesh.positions.length / 3, 0) } });
      owners.set(id, [...new Set([...native.meshes.map(mesh => mesh.expressId), ...native.shard.instances.map(instance => instance.entityId)])]);
      const hasOccurrences = native.meshes.some(mesh => meshClassIsPlaced(mesh.geometryClass ?? 0));
      const visible = native.meshes.filter(mesh => isMeshVisibleInViewMode(mesh.geometryClass ?? 0, 'model', hasOccurrences));
      scene.appendToBatches(visible, allocation.device, allocation.pipeline);
      scene.addInstancedShard(allocation.device, native.shard, i);
    }
    scene.finalizeStreaming(allocation.device, allocation.pipeline);
    setGlobalRendererRef({ current: renderer });
    const ids = [...owners.values()].flat(), source = first.coordinateInfo;
    const originalMetadata = structuredClone(source);
    const pristine = emptyPlacementState(), expectedBefore = sectionIndexedBounds(scene, ids);
    const before = placementCoordinateInfo(source, models, pristine); assert.ok(before);
    assert.deepEqual(before.shiftedBounds, expectedBefore, 'initial extent includes actual indexed native instances');
    assert.deepEqual(before.originalBounds, originalMetadata.originalBounds, 'source-frame metadata remains original');
    let moved = beginPlacement(pristine, [...models.keys()], new Set(models.keys()));
    moved = commitPlacement(previewPlacement(moved, [0, 0, 100]));
    for (const index of modelIndices(models).values()) renderer.setModelTranslation(index, [0, 100, 0]);
    const after = placementCoordinateInfo(source, models, moved); assert.ok(after);
    assert.deepEqual(after.shiftedBounds, sectionIndexedBounds(scene, ids));
    for (const edge of ['min', 'max'] as const) {
      assert.equal(after.shiftedBounds[edge].x, expectedBefore[edge].x);
      assert.equal(after.shiftedBounds[edge].z, expectedBefore[edge].z);
      assert.ok(Math.abs(after.shiftedBounds[edge].y - expectedBefore[edge].y - 100) < 0.0001);
    }
    if (count === 2) {
      const other = models.get('native-1')!; models.set('native-1', { ...other, visible: false });
      renderer.setModelTranslation(modelIndices(models).get('native-1')!, [0, 500, 0]);
      assert.deepEqual(placementCoordinateInfo(source, models, moved)?.shiftedBounds,
        sectionIndexedBounds(scene, owners.get('native-0')!), 'invisible federation owner never expands the extent');
    }
    setGlobalRendererRef({ current: null });
    const fallbackModels = new Map([['native-0', models.get('native-0')!]]);
    const fallback = placementCoordinateInfo(source, fallbackModels, moved); assert.ok(fallback);
    assert.deepEqual(fallback.shiftedBounds, {
      min: { ...source.shiftedBounds.min, y: source.shiftedBounds.min.y + 100 },
      max: { ...source.shiftedBounds.max, y: source.shiftedBounds.max.y + 100 },
    }, 'absent renderer retains producer bounds plus actual placement');
    assert.equal(placementCoordinateInfo(undefined, models, pristine), undefined);
    assert.deepEqual(source, originalMetadata);
    for (const native of sources) assert.equal(sourceDigest(native.source), 'd42ab0dee01173106c16cd823b4614efe188fa15dd65195d95b9879bec59acc5');
  } finally {
    setGlobalRendererRef({ current: previous }); scene.clear(); allocation.scene.clear();
    useViewerStore.getState().clearAllModels(); modelIndices(new Map());
  }
});
