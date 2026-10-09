/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { act, useMemo } from 'react';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { modelIndices } from '@/lib/model-placement/model-indices.js';
import { meshGeometryCounts, hasMeshGeometryProvenance } from '@/lib/released-mesh-provenance.js';
import { load, skip } from '@/test/blank-ifc-loader-harness.js';
import { cleanup, render } from '@/test/render.js';
import { useFederatedGeometry } from './useFederatedGeometry.js';
import { useFilteredGeometry } from './useFilteredGeometry.js';

let visible: MeshData[] = [];
let mergedMeshes: MeshData[] = [];
function Probe() {
  const state = useViewerStore();
  const indices = useMemo(() => modelIndices(state.models), [state.models]);
  const merged = useFederatedGeometry(state.models, state.geometryResult, indices, state.geometryContentVersion);
  const filtered = useFilteredGeometry(merged, state.geometryContentVersion, state.typeVisibility, state.typeViewMode);
  mergedMeshes = merged?.meshes ?? [];
  visible = filtered.filteredGeometry ?? [];
  return null;
}
function fingerprint(meshes: MeshData[]): string {
  const hash = createHash('sha256');
  for (const mesh of meshes) for (const field of [mesh.positions, mesh.normals, mesh.indices]) {
    hash.update(new Uint8Array(field.buffer, field.byteOffset, field.byteLength));
  }
  return hash.digest('hex');
}
afterEach(() => { cleanup(); visible = []; mergedMeshes = []; modelIndices(new Map()); });

it('canonical Bonsai IFC federation releases retained viewport aliases and preserves peer bytes (#6584)', { skip }, async context => {
  try {
    const bytes = readFileSync(new URL('../../../public/samples/hello-wall.ifc', import.meta.url));
    const file = () => new File([bytes], 'hello-wall.ifc', { type: 'application/ifc' });
    const primary = await load(file());
    const peer = await load(file(), 'peer');
    render(<Probe />);
    const source = useViewerStore.getState().models.get(primary.id)!.geometryResult!.meshes;
    const peerSource = useViewerStore.getState().models.get(peer.id)!.geometryResult!.meshes;
    assert.ok(source.length > 0 && peerSource.length > 0, 'actual WASM produced geometry for both canonical loads');
    const primaryIndex = modelIndices(useViewerStore.getState().models).get(primary.id);
    const aliases = mergedMeshes.filter(mesh => mesh.modelIndex === primaryIndex);
    const filteredAliases = visible.filter(mesh => mesh.modelIndex === primaryIndex);
    assert.ok(filteredAliases.length > 0 && filteredAliases.every(mesh => aliases.includes(mesh)),
      'the actual viewport filter retains a visible subset of the producer wrappers');
    assert.equal(aliases.length, source.length);
    assert.equal(fingerprint(aliases), fingerprint(source), 'viewport copies contain the actual producer geometry');
    const peerBefore = fingerprint(peerSource);
    context.diagnostic(JSON.stringify({ fixtureSha256: createHash('sha256').update(bytes).digest('hex'),
      primaryGeometrySha256: fingerprint(source), peerGeometrySha256: peerBefore,
      primaryMeshes: source.length, peerMeshes: peerSource.length, visiblePrimaryMeshes: filteredAliases.length,
      counts: source.map(meshGeometryCounts) }));
    const ids = aliases.map(mesh => mesh.expressId);
    const counts = aliases.map(meshGeometryCounts);
    assert.ok(counts.every(count => count.triangles > 0 && count.vertices > 0));
    act(() => { useViewerStore.getState().setActiveModel(primary.id); useViewerStore.setState({ boundedGeometryMode: true }); });
    const version = useViewerStore.getState().geometryContentVersion;
    act(() => useViewerStore.getState().updateMeshColors(new Map(ids.map(id => [id, [0, 1, 0, 1] as [number, number, number, number]]))));
    act(() => useViewerStore.getState().releaseGeometryMemory());
    for (const mesh of [...source, ...aliases]) {
      assert.equal(mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength, 0);
      assert.equal(hasMeshGeometryProvenance(mesh), true);
    }
    assert.deepEqual(aliases.map(meshGeometryCounts), counts);
    assert.deepEqual(aliases.map(mesh => mesh.expressId), ids);
    assert.equal(fingerprint(peerSource), peerBefore, 'releasing the active source preserves independent federated geometry');
    assert.equal(useViewerStore.getState().geometryContentVersion, version, 'CPU-only release preserves uploaded renderer identity');
  } finally { cleanup(); }
});
