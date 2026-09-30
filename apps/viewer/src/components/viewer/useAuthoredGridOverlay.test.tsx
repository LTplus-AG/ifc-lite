/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { MeshData } from '@ifc-lite/geometry';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { rectangularGridAxes } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { render, advance, cleanup } from '@/test/render';
import { seedModelingSession, MODEL_ID, STOREY } from '@/test/modeling-session-fixture';
import { addGridIn } from '@/store/slices/mutation-curtain-grid';
import { toHostHiddenIfcTypes } from '@/lib/host-hidden-ifc-types';
import { useOverlayChannelGate } from '@/hooks/useOverlayChannelGate';
import { useAuthoredGridOverlay } from './useAuthoredGridOverlay';

function Probe() {
  useAuthoredGridOverlay();
  const shown = useViewerStore((s) => s.typeVisibility.ifcGrid);
  const fileGate = useOverlayChannelGate(false, shown);
  return <span data-file-grid-visible={String(fileGate.grid)} />;
}

async function fixture(modelCount: 1 | 2) {
  await seedModelingSession();
  if (modelCount === 2) {
    const first = useViewerStore.getState().models.get(MODEL_ID)!;
    await seedModelingSession(); // independently parsed stores, overlapping local express IDs
    const second = { ...useViewerStore.getState().models.get(MODEL_ID)!, id: 'second', idOffset: 1_000_000 };
    useViewerStore.setState({
      models: new Map([[MODEL_ID, first], [second.id, second]]),
      mutationViews: new Map([
        [MODEL_ID, new MutablePropertyView(first.ifcDataStore?.properties ?? null, MODEL_ID)],
        [second.id, new MutablePropertyView(second.ifcDataStore?.properties ?? null, second.id)],
      ]),
    });
  }
  for (const [index, id] of [...useViewerStore.getState().models.keys()].entries()) {
    const made = addGridIn(useViewerStore, id, STOREY, {
      Position: [index * 20, 0, 0], ...rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4] }),
    });
    assert.ok('expressId' in made, 'canonical builder created the parsed model grid');
  }
  let meshes: MeshData[] = [];
  let uploads = 0;
  const state = useViewerStore.getState();
  useViewerStore.setState({
    typeVisibility: { ...state.typeVisibility, ifcGrid: true }, hostHiddenIfcTypes: null,
    cameraCallbacks: { ...state.cameraCallbacks, setAuthoringOverlayMeshes: (channel, next) => {
      if (channel === 'grids') { meshes = next; uploads++; }
    } },
  });
  const ui = render(<Probe />);
  await advance(20);
  const triangles = () => meshes.reduce((sum, m) => sum + m.indices.length / 3, 0);
  assert.equal(triangles(), modelCount * 4 * 12, 'all authored axes reach the real upload seam');
  return { ui, triangles, uploads: () => uploads };
}

afterEach(() => {
  cleanup();
  useViewerStore.getState().exitModelWorkspace();
  useViewerStore.setState({ hostHiddenIfcTypes: null });
});

for (const models of [1, 2] as const) {
  describe(`#6511 authored grid visibility with ${models} parsed models`, () => {
    it('global hide clears authored strips and show restores them alongside the file-grid gate', async () => {
      const f = await fixture(models);
      act(() => useViewerStore.getState().toggleTypeVisibility('ifcGrid'));
      await advance(20);
      assert.equal(f.ui.querySelector('[data-file-grid-visible]')?.getAttribute('data-file-grid-visible'), 'false');
      assert.equal(f.triangles(), 0);
      act(() => useViewerStore.getState().toggleTypeVisibility('ifcGrid'));
      await advance(20);
      assert.equal(f.ui.querySelector('[data-file-grid-visible]')?.getAttribute('data-file-grid-visible'), 'true');
      assert.equal(f.triangles(), models * 4 * 12);
    });

    it('host IfcGridAxis hideTypes stays authoritative across global toggle changes and releases both channels', async () => {
      const f = await fixture(models);
      act(() => useViewerStore.setState({ hostHiddenIfcTypes: toHostHiddenIfcTypes(['IFCGRIDAXIS']) }));
      await advance(20);
      assert.equal(f.triangles(), 0);
      act(() => {
        useViewerStore.getState().toggleTypeVisibility('ifcGrid');
        useViewerStore.getState().toggleTypeVisibility('ifcGrid');
      });
      await advance(20);
      assert.equal(f.triangles(), 0, 'turning the user toggle on cannot reveal host-hidden grids');
      assert.equal(f.ui.querySelector('[data-file-grid-visible]')?.getAttribute('data-file-grid-visible'), 'false');
      act(() => useViewerStore.setState({ hostHiddenIfcTypes: null }));
      await advance(20);
      assert.equal(f.triangles(), models * 4 * 12);
    });

    it('unrelated edits keep the upload, while a replacement renderer receives visible axes', async () => {
      const f = await fixture(models);
      const before = f.uploads();
      act(() => useViewerStore.setState((s) => ({ mutationVersion: s.mutationVersion + 1 })));
      await advance(20);
      assert.equal(f.uploads(), before);
      let replacement: MeshData[] = [];
      act(() => useViewerStore.setState((s) => ({ cameraCallbacks: {
        ...s.cameraCallbacks, setAuthoringOverlayMeshes: (channel, meshes) => { if (channel === 'grids') replacement = meshes; },
      } })));
      await advance(20);
      assert.equal(replacement.reduce((sum, m) => sum + m.indices.length / 3, 0), models * 4 * 12);
    });
  });
}
