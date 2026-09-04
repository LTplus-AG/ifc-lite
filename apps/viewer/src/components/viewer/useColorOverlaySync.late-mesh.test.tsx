/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Colour reaches parts whose meshes stream in AFTER the colour was applied
 * (#3890).
 *
 * #3880 made hide and isolate complete at action time by expanding an assembly
 * to every aggregated descendant: those two are whitelists the renderer
 * re-matches mesh ids against, so a mesh-less id starts matching the moment
 * its mesh lands. Colour gets no such benefit. `pendingColorUpdates` is a
 * one-shot signal — `useColorOverlaySync` hands it to `scene.setColorOverrides`
 * and nulls it out — and `setColorOverrides` builds overlay batches ONCE by
 * looking each id up in `meshDataMap`. An id with no mesh at flush time
 * contributes nothing to a batch and nothing ever revisits it.
 *
 * The stub scene below models exactly that: `setColorOverrides` retains the
 * map and derives `paintedIds` from the ids that currently have a mesh. The
 * real `Scene` does the same thing (packages/renderer/src/scene.ts: it copies
 * `overrides` into `this.colorOverrides`, then walks the map and only pushes
 * `meshDataMap.get(expressId)` pieces into a colour group).
 *
 * The two hazards recorded on the issue get a test each:
 *   - a targeted `resetColors([part])` must not be repainted by the next tick;
 *   - the repaint must not undo a user's LATER correction.
 * Both are covered by re-reading `scene.getColorOverrides()` at the moment the
 * debounce fires rather than capturing a map when it is scheduled, and both
 * are asserted below so that a future "optimisation" that captures early
 * fails here.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Renderer } from '@ifc-lite/renderer';
import { createViewerAdapter } from '../../sdk/adapters/viewer-adapter.js';
import type { StoreApi } from '../../sdk/adapters/types.js';
import { useColorOverlaySync } from './useColorOverlaySync.js';

type Color = [number, number, number, number];
type ColorMap = Map<number, Color>;

/**
 * Stands in for `Scene`'s colour-overlay half. `paintedIds` is the overlay
 * batch: built once per `setColorOverrides` call from the ids that have a mesh
 * RIGHT NOW, which is the defect's whole mechanism.
 */
class StubScene {
  meshedIds = new Set<number>();
  private overrides: ColorMap | null = null;
  paintedIds: number[] = [];
  setColorOverridesCalls = 0;

  setColorOverrides(overrides: ColorMap): void {
    this.setColorOverridesCalls++;
    if (overrides.size === 0) {
      this.overrides = null;
      this.paintedIds = [];
      return;
    }
    this.overrides = new Map(overrides);
    this.paintedIds = [...overrides.keys()].filter((id) => this.meshedIds.has(id));
  }

  getColorOverrides(): ColorMap | null {
    return this.overrides;
  }

  /** `meshDataMap` presence: what the hook asks to decide whether an id that
   *  had no mesh at the last build has since gained one. */
  hasMeshData(expressId: number): boolean {
    return this.meshedIds.has(expressId);
  }

  isInstancedEntity(): boolean {
    return false;
  }

  /** Meshes are RECEIVED into a queue and only enter `meshDataMap` when the
   *  animation loop drains it, so "a batch arrived" and "the mesh is paintable"
   *  are different moments. Scenarios that care set this. */
  queuedMeshes = false;

  hasQueuedMeshes(): boolean {
    return this.queuedMeshes;
  }

  clearColorOverrides(): void {
    this.overrides = null;
    this.paintedIds = [];
  }
}

function fakeRenderer(scene: StubScene): Renderer {
  return {
    getGPUDevice: () => ({}) as unknown,
    getPipeline: () => ({}) as unknown,
    getScene: () => scene,
    requestRender: () => {},
  } as unknown as Renderer;
}

/** The store shape `createViewerAdapter` actually reads, with idOffset 0 so a
 *  ref's expressId IS its global id. */
function makeStore(): { store: StoreApi; getPending: () => ColorMap | null; clear: () => void } {
  let pendingColorUpdates: ColorMap | null = null;
  const state = {
    models: new Map([['default', { idOffset: 0 }]]),
    // #3880's expansion: the assembly resolves to both of its parts, meshed or
    // not. This is `cameraCallbacks.resolveHighlightIds`' post-#3865 answer.
    cameraCallbacks: {
      resolveHighlightIds: (ids: number[]) =>
        ids.flatMap((id) => (id === ASSEMBLY ? [PART_MESHED, PART_LATE] : [id])),
    },
    get pendingColorUpdates() {
      return pendingColorUpdates;
    },
    setPendingColorUpdates: (updates: ColorMap) => {
      pendingColorUpdates = new Map(updates);
    },
  };
  return {
    store: { getState: () => state, subscribe: () => () => {} } as unknown as StoreApi,
    getPending: () => pendingColorUpdates,
    clear: () => {
      pendingColorUpdates = null;
    },
  };
}

const ASSEMBLY = 100;
const PART_MESHED = 101;
const PART_LATE = 102;
const RED: Color = [1, 0, 0, 1];
const BLUE: Color = [0, 0, 1, 1];

/** Debounce window in `useColorOverlaySync`, plus slack. */
const PAST_DEBOUNCE_MS = 400;

function Harness({
  rendererRef,
  pendingColorUpdates,
  clearPendingColorUpdates,
  geometryVersion,
}: {
  rendererRef: { current: Renderer | null };
  pendingColorUpdates: ColorMap | null;
  clearPendingColorUpdates: () => void;
  geometryVersion: number;
}) {
  useColorOverlaySync({
    rendererRef,
    isInitialized: true,
    pendingColorUpdates,
    clearPendingColorUpdates,
    geometryVersion,
  });
  return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drives one scenario: the real adapter writes into the real-shaped store, the
 * real hook flushes into the stub scene, then a mesh lands and the geometry
 * counter bumps.
 */
async function mount(scene: StubScene) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const rendererRef = { current: fakeRenderer(scene) };
  const { store, getPending, clear } = makeStore();
  const adapter = createViewerAdapter(store);
  let version = 0;

  const render = async () => {
    await act(async () => {
      root.render(
        <Harness
          rendererRef={rendererRef}
          pendingColorUpdates={getPending()}
          clearPendingColorUpdates={clear}
          geometryVersion={version}
        />,
      );
    });
  };

  return {
    adapter,
    render,
    async bumpGeometry() {
      version++;
      await render();
      await act(async () => {
        await sleep(PAST_DEBOUNCE_MS);
      });
    },
    /** Let pending timers run without bumping the geometry counter. */
    async settle() {
      await act(async () => {
        await sleep(PAST_DEBOUNCE_MS);
      });
    },
    cleanup() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('useColorOverlaySync — colour reaches late-streamed meshes (#3890)', () => {
  it('repaints a part whose mesh arrives after the colour was flushed', async () => {
    const scene = new StubScene();
    scene.meshedIds.add(PART_MESHED);
    const h = await mount(scene);
    try {
      h.adapter.colorize([{ modelId: 'default', expressId: ASSEMBLY }], RED);
      await h.render();

      assert.deepEqual(
        scene.paintedIds.sort(),
        [PART_MESHED],
        'only the already-meshed part can be in the first overlay batch',
      );

      // PART_LATE's mesh streams in.
      scene.meshedIds.add(PART_LATE);
      await h.bumpGeometry();

      assert.ok(
        scene.paintedIds.includes(PART_LATE),
        'the late part must be in the rebuilt overlay batch',
      );
      assert.ok(
        scene.paintedIds.includes(PART_MESHED),
        'the already-painted part must survive the rebuild',
      );
    } finally {
      h.cleanup();
    }
  });

  it('leaves a part the user reset alone when its mesh arrives later', async () => {
    const scene = new StubScene();
    scene.meshedIds.add(PART_MESHED);
    const h = await mount(scene);
    try {
      h.adapter.colorize([{ modelId: 'default', expressId: ASSEMBLY }], RED);
      await h.render();
      // The user un-colours the part that has not rendered yet.
      h.adapter.resetColors([{ modelId: 'default', expressId: PART_LATE }]);
      await h.render();

      scene.meshedIds.add(PART_LATE);
      await h.bumpGeometry();

      assert.equal(
        scene.paintedIds.includes(PART_LATE),
        false,
        'a reset part must stay reset when its mesh lands',
      );
      assert.ok(scene.paintedIds.includes(PART_MESHED), 'the rest of the assembly stays painted');
    } finally {
      h.cleanup();
    }
  });

  it('applies a correction made before the late mesh landed, not the older colour', async () => {
    const scene = new StubScene();
    scene.meshedIds.add(PART_MESHED);
    const h = await mount(scene);
    try {
      h.adapter.colorize([{ modelId: 'default', expressId: ASSEMBLY }], RED);
      await h.render();
      // The user corrects the still-unmeshed part to BLUE. The catch-up has
      // not run yet, so this is the map it will find when it does.
      h.adapter.colorize([{ modelId: 'default', expressId: PART_LATE }], BLUE);
      await h.render();

      scene.meshedIds.add(PART_LATE);
      await h.bumpGeometry();

      assert.ok(
        scene.paintedIds.includes(PART_LATE),
        'the catch-up must actually run for this test to mean anything',
      );
      assert.deepEqual(
        scene.getColorOverrides()?.get(PART_LATE),
        BLUE,
        'the correction must survive: the catch-up re-reads the scene map rather than replaying an older one',
      );
      assert.deepEqual(scene.getColorOverrides()?.get(PART_MESHED), RED);
    } finally {
      h.cleanup();
    }
  });

  it('stops rebuilding once every override that can be painted has been', async () => {
    const scene = new StubScene();
    scene.meshedIds.add(PART_MESHED);
    const h = await mount(scene);
    try {
      h.adapter.colorize([{ modelId: 'default', expressId: ASSEMBLY }], RED);
      await h.render();

      // What makes this test bite, pinned rather than assumed: the map keeps
      // the geometry-less ASSEMBLY id next to its parts. The fixture's resolver
      // answers with the parts only, but `resolvePresentationColorMap` unions
      // the raw ids back in (#2680's never-substitute policy), so the id that
      // can never gain a mesh IS in the override map, exactly as in the app.
      assert.ok(
        scene.getColorOverrides()?.has(ASSEMBLY),
        'the geometry-less assembly id must be in the override map',
      );
      assert.equal(scene.hasMeshData(ASSEMBLY), false, 'and it never gains a mesh');

      scene.meshedIds.add(PART_LATE);
      await h.bumpGeometry();
      const afterCatchUp = scene.setColorOverridesCalls;

      // Two more streaming bursts that bring nothing the overlay is waiting
      // for. Because ASSEMBLY stays unmeshed forever, "is anything still
      // waiting" would rebuild here on every burst, for the life of the
      // overlay. "Did an awaited id arrive" is the question that terminates.
      await h.bumpGeometry();
      await h.bumpGeometry();

      assert.equal(
        scene.setColorOverridesCalls,
        afterCatchUp,
        'a burst that lands no awaited mesh must not rebuild the overlay batches',
      );
    } finally {
      h.cleanup();
    }
  });

  it('waits for the mesh queue to drain instead of spending its one shot mid-drain', async () => {
    const scene = new StubScene();
    scene.meshedIds.add(PART_MESHED);
    const h = await mount(scene);
    try {
      h.adapter.colorize([{ modelId: 'default', expressId: ASSEMBLY }], RED);
      await h.render();

      // The last batch has been RECEIVED — the counter bumps and will never
      // bump again — but the animation loop has not drained it, so PART_LATE
      // is not in meshDataMap yet.
      scene.queuedMeshes = true;
      await h.bumpGeometry();
      assert.equal(
        scene.paintedIds.includes(PART_LATE),
        false,
        'nothing to paint yet: the mesh is still queued',
      );

      // The drain completes. No further geometry counter bump follows.
      scene.queuedMeshes = false;
      scene.meshedIds.add(PART_LATE);
      await h.settle();

      assert.ok(
        scene.paintedIds.includes(PART_LATE),
        'the catch-up must retry across the drain, not give up after one attempt',
      );
    } finally {
      h.cleanup();
    }
  });
});
