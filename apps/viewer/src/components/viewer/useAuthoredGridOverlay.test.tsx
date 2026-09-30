/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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
import { emptyPlacementState } from '@/lib/model-placement/state';

function Probe() {
  useAuthoredGridOverlay();
  const shown = useViewerStore((s) => s.typeVisibility.ifcGrid);
  const fileGate = useOverlayChannelGate(false, shown);
  return <span data-file-grid-visible={String(fileGate.grid)} />;
}

let strictMount: { root: Root; container: HTMLElement } | null = null;

async function fixture(modelCount: 1 | 2, strict = false) {
  await seedModelingSession();
  useViewerStore.setState({ modelPlacement: emptyPlacementState() });
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
    }, clearAuthoringOverlayMeshes: (channel) => { if (channel === 'grids') meshes = []; } },
  });
  let ui: HTMLElement;
  if (strict) {
    // React replays initial effects only when StrictMode is at the root;
    // render()'s TooltipProvider wrapper would leave it below the root.
    ui = document.createElement('div');
    document.body.appendChild(ui);
    const root = createRoot(ui);
    strictMount = { root, container: ui };
    act(() => root.render(<StrictMode><Probe /></StrictMode>));
  } else ui = render(<Probe />);
  await advance(20);
  const triangles = () => meshes.reduce((sum, m) => sum + m.indices.length / 3, 0);
  assert.equal(triangles(), modelCount * 4 * 12, 'all authored axes reach the real upload seam');
  return { ui, triangles, uploads: () => uploads, positions: () => Array.from(meshes[0]?.positions ?? []) };
}

afterEach(() => {
  if (strictMount) {
    act(() => strictMount!.root.unmount());
    strictMount.container.remove();
    strictMount = null;
  }
  cleanup();
  useViewerStore.getState().exitModelWorkspace();
  useViewerStore.setState({ hostHiddenIfcTypes: null });
});

for (const models of [1, 2] as const) {
  describe(`#6511 authored grid visibility with ${models} parsed models`, () => {
    it('redraws translated axes through preview, commit, undo and redo (#6511 review)', async () => {
      const f = await fixture(models);
      const before = f.positions();
      const movedLength = before.length / models;
      act(() => {
        useViewerStore.getState().openReposition([MODEL_ID]);
        useViewerStore.getState().previewModelTranslation([3, 4, 5]);
      });
      await advance(20);
      const expected = before.map((value, index) => index < movedLength
        ? value + [3, 5, -4][index % 3] : value);
      const assertPositions = (positions: number[]) => {
        assert.equal(f.positions().length, positions.length);
        f.positions().forEach((value, index) => assert.ok(Math.abs(value - positions[index]) < 1e-5, `vertex coordinate ${index}`));
      };
      assertPositions(expected);
      act(() => useViewerStore.getState().applyModelTranslation());
      await advance(20);
      assertPositions(expected);
      act(() => useViewerStore.getState().undoModelTranslation());
      await advance(20);
      assertPositions(before);
      act(() => useViewerStore.getState().redoModelTranslation());
      await advance(20);
      assertPositions(expected);
    });

    it('redraws a quarter-turn about the origin while other models stay fixed (#6511 review)', async () => {
      const f = await fixture(models);
      const before = f.positions();
      const movedLength = before.length / models;
      act(() => useViewerStore.getState().setModelRotation([MODEL_ID], { angle: Math.PI / 2, pivot: [0, 0, 0] }));
      await advance(20);
      const after = f.positions();
      assert.equal(after.length, before.length);
      for (let i = 0; i < before.length; i += 3) {
        const expected = i < movedLength ? [before[i + 2], before[i + 1], -before[i]] : before.slice(i, i + 3);
        expected.forEach((value, axis) => assert.ok(Math.abs(after[i + axis] - value) < 1e-5, `rotated vertex ${i / 3}, axis ${axis}`));
      }
    });

    it('keeps existing axes visible after StrictMode setup/cleanup replay (#6511 review)', async () => {
      const f = await fixture(models, true);
      assert.equal(f.triangles(), models * 4 * 12);
    });

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
