/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { act, useMemo } from 'react';
import type { MeshData } from '@ifc-lite/geometry';
import { diffCounters, perfCounters } from '@ifc-lite/load-trace';
import { useViewerStore } from '@/store';
import { modelIndices } from '@/lib/model-placement/model-indices.js';
import { meshGeometryCounts } from '@/lib/released-mesh-provenance.js';
import { cleanup, render } from '@/test/render.js';
import { load, skip as wasmSkip } from '@/test/blank-ifc-loader-harness.js';
import { useFederatedGeometry } from './useFederatedGeometry.js';
import { useAppearanceSourceGeometry } from './useAppearanceSourceGeometry.js';

// Real Archicad architecture and Autodesk structural model families. The
// canonical loader supplies frames, colours, owners and federation IDs; this
// test replays its produced meshes through the actual streaming store action.
const fixtures = [
  new URL('../../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url),
  new URL('../../../../../tests/models/various/01_Snowdon_Towers_Sample_Structural(1).ifc', import.meta.url),
];
const skip = wasmSkip || (fixtures.every(path => existsSync(path)) ? false
  : 'Run pnpm fixtures for ara3d/AC20-FZK-Haus.ifc and the Snowdon structural fixture (#6537).');
let sources: MeshData[] = [];
let indices: ReadonlyMap<string, number> = new Map();

function Probe() {
  const { models, geometryResult, geometryContentVersion: contentVersion } = useViewerStore();
  indices = useMemo(() => modelIndices(models), [models]);
  // ViewportContainer derives visible geometry before its Viewport child
  // requests appearance sources. Preserve that stamping/copy interaction.
  useFederatedGeometry(models, geometryResult, indices, contentVersion);
  sources = useAppearanceSourceGeometry(models, indices, contentVersion);
  return <output>{sources.length}</output>;
}

/** Ordered CPU geometry, appearance, owner and frame identity. This is a
 * same-run preservation control, not an independent geometry oracle. */
function fingerprint(meshes: readonly MeshData[]): string {
  const hash = createHash('sha256');
  for (const mesh of meshes) {
    hash.update(JSON.stringify([mesh.expressId, mesh.geometryItemId, mesh.materialId,
      mesh.ifcType, mesh.color, mesh.shadingColor, mesh.material, mesh.origin,
      mesh.geometryClass, mesh.localToWorld, mesh.localBounds, mesh.occurrenceKey]));
    for (const data of [mesh.positions, mesh.normals, mesh.indices, mesh.uvs,
      mesh.entityIds, mesh.appearanceSource?.sourceIndices, mesh.appearanceSource?.cornerIndices]) {
      hash.update(String(data?.byteLength ?? -1));
      if (data) hash.update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
  }
  return hash.digest('hex');
}

function assertOrderedSources(): void {
  const expected = [...useViewerStore.getState().models.values()]
    .flatMap(model => model.geometryResult?.meshes ?? []);
  assert.equal(fingerprint(sources), fingerprint(expected),
    'appearance sources preserve complete ordered producer geometry, colour and frame data');
  let offset = 0;
  for (const [id, model] of useViewerStore.getState().models) {
    const meshes = model.geometryResult?.meshes ?? [];
    for (let i = 0; i < meshes.length; i++) {
      assert.equal(sources[offset + i].modelIndex, indices.get(id), 'renderer ownership follows its model');
      assert.equal(sources[offset + i].positions, meshes[i].positions, 'CPU backing is borrowed from the producer');
    }
    offset += meshes.length;
  }
}

async function loadWithProbe(file: File, modelId?: string) {
  let model: Awaited<ReturnType<typeof load>> | undefined;
  // The shared harness enables editing after its own load act. Include that
  // notification in this mounted probe's act scope, one load at a time.
  await act(async () => { model = await load(file, modelId); });
  assert.ok(model);
  return model;
}

afterEach(() => { cleanup(); sources = []; indices = new Map(); modelIndices(new Map()); });

for (const position of [0, 1] as const) {
  it(`visits only new real IFC appearance meshes when model ${position} appends (#6537 / #7021)`,
    { skip, timeout: 120_000 }, async context => {
      try {
        const bytes = fixtures.map(path => readFileSync(path));
        perfCounters.enable();
        const beforeLoad = perfCounters.read();
        const ui = render(<Probe />);
        const initial = [
          await loadWithProbe(new File([bytes[0]], 'AC20-FZK-Haus.ifc', { type: 'application/ifc' })),
          await loadWithProbe(new File([bytes[1]], 'Snowdon-structural.ifc', { type: 'application/ifc' }), 'appearance-peer'),
        ];
        const loadDelta = diffCounters(perfCounters.read(), beforeLoad);
        const state = useViewerStore.getState();
        assert.equal(state.models.size, 2, 'both canonical loads remain in the federation');
        const loaded = initial.map(model => {
          const current = state.models.get(model.id);
          assert.ok(current, 'read the current model after federation alignment');
          return current;
        });
        const target = loaded[position];
        assert.ok(target.geometryResult);
        const complete = target.geometryResult.meshes.slice();
        assert.ok(complete.length > 1, 'the actual engine supplies a nontrivial stream');
        assert.ok(loaded[1 - position].geometryResult?.meshes.length,
          'an independently loaded peer exercises the retained-prefix/suffix cost');
        const originalIdentity = fingerprint(complete);
        const previouslyStamped = complete.filter(mesh => mesh.modelIndex === indices.get(target.id)).length;
        act(() => useViewerStore.getState().upsertModel({ ...target, preAlignment: undefined,
          geometryResult: { ...target.geometryResult!, meshes: [], totalVertices: 0, totalTriangles: 0 },
        }));
        assertOrderedSources();
        const appearanceList = sources;
        const before = perfCounters.read();
        // A fixed batch schedule attributes repeated prefix work. This is an
        // untimed mounted replay, not a browser worker-pool performance cohort.
        const batchSize = Math.max(1, Math.ceil(complete.length / 16));
        let batches = 0;
        for (let offset = 0; offset < complete.length; offset += batchSize) {
          const part = complete.slice(offset, offset + batchSize);
          act(() => useViewerStore.getState().appendGeometryBatch(target.id, part, target.geometryResult!.coordinateInfo));
          assertOrderedSources();
          assert.equal(Number(ui.textContent), sources.length, 'the mounted consumer observes every batch');
          batches++;
        }
        assert.equal(fingerprint(complete), originalIdentity, 'replay does not alter canonical mesh output');
        const delta = diffCounters(perfCounters.read(), before);
        context.diagnostic(JSON.stringify({ kind: 'real-ifc-appearance-stream-attribution', position, batches, batchSize,
          fixtures: bytes.map((data, i) => ({ name: fixtures[i].pathname.split('/').at(-1), bytes: data.length,
            sha256: createHash('sha256').update(data).digest('hex') })),
          models: loaded.map(model => ({ id: model.id, meshes: model.geometryResult?.meshes.length })),
          replayMeshes: complete.length, previouslyStamped, replayGeometrySha256: originalIdentity,
          counts: complete.reduce((sum, mesh) => {
            const counts = meshGeometryCounts(mesh);
            return { vertices: sum.vertices + counts.vertices, triangles: sum.triangles + counts.triangles };
          }, { vertices: 0, triangles: 0 }), loadDelta, delta,
          scope: 'Mounted canonical-output replay; no timing, GPU, whole-load memory or worker-pool acceptance.' }));
        assert.equal(delta['viewer.appearanceSource.meshes'] ?? 0, complete.length,
          'old peer and accumulated meshes must not be revisited on each append');
        assert.equal(delta['viewer.appearanceSource.copies'] ?? 0, 0,
          'renderer ownership must use canonical stamping rather than per-append wrapper copies');
        assert.equal(sources, appearanceList, 'same-array appends retain the combined list');
        assert.equal(delta['viewer.appearanceSource.shiftedMeshes'] ?? 0,
          position === 0 ? batches * loaded[1].geometryResult!.meshes.length : 0,
          'earlier-model suffix movement is counted separately from new mesh work');
      } finally { cleanup(); }
    });
}
