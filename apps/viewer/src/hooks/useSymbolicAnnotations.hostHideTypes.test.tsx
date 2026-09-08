/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The host's `hideTypes` reaching the symbolic 2D overlay (#2934), driven for
 * real: the actual hooks, mounted, over a real parse, reading the real store.
 *
 * **Why this file exists at this level.** The fix is a chain — the embed
 * publishes the host's hidden classes to the store, the hooks gate their two
 * channels on it — and a gate placed in `Viewport` would be pinned by nothing:
 * `Viewport` is `vi.mock`ed in every viewer-embed test file, no test in this
 * repo mounts it (it needs a WebGPU device), so deleting `Viewport`'s
 * CONSUMPTION of a gate would restore the silent no-op with the whole embed
 * suite green. Reading the store inside the hooks removes that link rather
 * than testing around it: the gate sits beside the per-entity hides these
 * hooks already apply, where a mount can see it.
 *
 * The fixture is the one `useSymbolicAnnotations.gridBubbleExtent.test.tsx`
 * established — one `IfcAnnotation` primitive and one `IfcGridAxis` primitive
 * of each kind, told apart by X coordinate — because the property under test
 * is precisely that the two owner classes are hidden INDEPENDENTLY.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { toHostHiddenIfcTypes } from '@/lib/host-hidden-ifc-types.js';
import { OVERLAY_CHANNEL_OWNER_TYPES } from '@/lib/overlay-parse/overlay-channels.js';
import { __setOverlayWorkerFactoryForTest } from '@/lib/overlay-parse/index.js';
import { createEmptyFlatSymbolic, type FlatSymbolic } from '@/lib/overlay-parse/symbolic-flat.js';
import { __resetSymbolicAnnotationsCacheForTests } from './symbolic-parse-cache.js';
import {
  useSymbolicAnnotations,
  useSymbolicAnnotationsRichData,
} from './useSymbolicAnnotations.js';

/**
 * The class names come FROM the channel table, never retyped. The first
 * attempt at #2934 asked the host about `'IfcGrid'` and its test asserted the
 * same wrong spelling, so the pair agreed with each other and with nothing in
 * the data.
 */
const ANNOTATION_TYPE = OVERLAY_CHANNEL_OWNER_TYPES.annotation[0];
const GRID_TYPE = OVERLAY_CHANNEL_OWNER_TYPES.grid[0];

/** X of the annotation primitives; the grid sits far out, the way grids do. */
const ANNOTATION_X = 1;
const GRID_X = 1000;

/**
 * One annotation-owner and one grid-owner line and label. `NaN` world Y keeps
 * every primitive in the loose buckets — storey resolution is a different
 * subject with its own tests.
 */
function annotationAndGrid(): FlatSymbolic {
  const f = createEmptyFlatSymbolic();
  f.typeNames = [ANNOTATION_TYPE, GRID_TYPE];

  f.polyPoints = Float32Array.from([ANNOTATION_X, 0, ANNOTATION_X, 1, GRID_X, 0, GRID_X, 1]);
  f.polyStart = Uint32Array.from([0, 2, 4]);
  f.polyOwner = Uint32Array.from([2, 3]);
  f.polyWorldY = Float32Array.from([NaN, NaN]);
  f.polyFlags = Uint8Array.from([0, 0]);
  f.polyType = Uint16Array.from([0, 1]);

  f.textContent = ['DIM', 'A'];
  f.textAlignment = ['center', 'center'];
  f.textX = Float32Array.from([ANNOTATION_X, GRID_X]);
  f.textY = Float32Array.from([0, 0]);
  f.textDirX = Float32Array.from([1, 1]);
  f.textDirY = Float32Array.from([0, 0]);
  f.textHeight = Float32Array.from([1, 1]);
  f.textTargetPx = Float32Array.from([0, 0]);
  f.textColor = new Float32Array(8);
  f.textOwner = Uint32Array.from([2, 3]);
  f.textWorldY = Float32Array.from([NaN, NaN]);
  f.textType = Uint16Array.from([0, 1]);

  return f;
}

function store(): IfcDataStore {
  return {
    source: { contentKey: 'host-hide-types-bytes', byteLength: 10, toTransferable: () => ({}) },
  } as unknown as IfcDataStore;
}

/** A worker stand-in that answers every request with the fixture above. */
function installWorker(): () => void {
  const previous = __setOverlayWorkerFactoryForTest(() => {
    const worker = {
      postMessage(request: { id: number }) {
        setTimeout(() => {
          worker.onmessage?.({ data: { id: request.id, ok: true, flat: annotationAndGrid() } });
        }, 0);
      },
      terminate() {},
      onmessage: null as ((event: { data: unknown }) => void) | null,
    };
    return worker as unknown as Worker;
  });
  return () => { __setOverlayWorkerFactoryForTest(previous); };
}

/** What the overlay would upload: line vertices per channel, and the labels. */
interface Sample {
  annotationVerts: number;
  gridVerts: number;
  texts: readonly string[];
}

let root: Root | null = null;
let container: HTMLElement | null = null;

/**
 * Mount both overlay hooks with both store toggles ON — so anything missing
 * from the result was removed by the host's hide list and by nothing else —
 * and let the parse land.
 */
async function sample(hideTypes: string[]): Promise<Sample> {
  // Tear the previous mount down BEFORE the store write below, so no Probe
  // from an earlier `sample()` is still subscribed and re-rendering outside
  // `act()`. Same reason `gridBubbleExtent.test.tsx` spells this out.
  if (root && container) {
    const staleRoot = root;
    const staleContainer = container;
    act(() => staleRoot.unmount());
    staleContainer.remove();
    root = null;
    container = null;
  }
  useViewerStore.setState({ hostHiddenIfcTypes: toHostHiddenIfcTypes(hideTypes) } as never);

  let latest: Sample | null = null;
  function Probe(): null {
    const lines = useSymbolicAnnotations({ enabled: true, gridEnabled: true });
    const rich = useSymbolicAnnotationsRichData({ enabled: true, gridEnabled: true });
    latest = {
      annotationVerts: lines.annotation.length,
      gridVerts: lines.grid.length,
      texts: rich.texts.map((t) => t.content),
    };
    return null;
  }

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<Probe />); });
  // The parse is async: the worker replies on a macrotask, the cache notifies,
  // the hook re-renders. Drain that before reading.
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });

  assert.ok(latest, 'the probe never rendered');
  return latest;
}

describe('hideTypes reaches the symbolic 2D overlay (#2934)', () => {
  let restoreWorker: (() => void) | null = null;

  beforeEach(() => {
    __resetSymbolicAnnotationsCacheForTests();
    restoreWorker = installWorker();
    useViewerStore.setState({
      ifcDataStore: store(),
      models: new Map(),
      hiddenEntities: new Set<number>(),
      lensHiddenIds: new Set<number>(),
      hiddenEntitiesByModel: new Map(),
      hostHiddenIfcTypes: null,
    } as never);
  });

  afterEach(() => {
    if (root && container) {
      const r = root;
      const c = container;
      act(() => r.unmount());
      c.remove();
    }
    root = null;
    container = null;
    restoreWorker?.();
    restoreWorker = null;
    useViewerStore.setState({ hostHiddenIfcTypes: null } as never);
  });

  it('draws both channels when the host hid nothing', async () => {
    // The control. Without it every assertion below could pass because the
    // fixture never arrived — the exact vacuity #3393 was filed for.
    const s = await sample([]);
    assert.ok(s.annotationVerts > 0, 'annotation lines must draw');
    assert.ok(s.gridVerts > 0, 'grid lines must draw');
    assert.deepEqual([...s.texts].sort(), ['A', 'DIM']);
  });

  it('drops the annotation channel for the annotation owner class, grid intact', async () => {
    // KILLS: reverting the hooks to gate on the caller's `enabled` /
    // `gridEnabled` alone (`useOverlayChannelGate` deleted, or its result
    // ignored). That is the shipped behaviour this fix exists to end: the
    // overlay is not a mesh, so the embed's mesh filter never reached it and
    // `hideTypes: ['IfcAnnotation']` moved 0 of 960,000 pixels where the store
    // toggle moved 6,492.
    const s = await sample([ANNOTATION_TYPE]);
    assert.equal(s.annotationVerts, 0);
    assert.ok(s.gridVerts > 0, `hiding ${ANNOTATION_TYPE} must not take the grid with it`);
    assert.deepEqual(s.texts, ['A']);
  });

  it('drops the grid channel for the grid owner class, annotations intact', async () => {
    // KILLS: gating only the annotation channel, and the first attempt's
    // actual defect — asking the host about `'IfcGrid'`, which is not the
    // class in the data. A host naming the class their file really contains
    // would have got the same silence the fix was written to remove.
    const s = await sample([GRID_TYPE]);
    assert.equal(s.gridVerts, 0);
    assert.ok(s.annotationVerts > 0, `hiding ${GRID_TYPE} must not take annotations with it`);
    assert.deepEqual(s.texts, ['DIM']);
  });

  it('takes the SCREAMING_CASE spelling the SDK documents', async () => {
    // KILLS: dropping the case folding between the host list and the store.
    const s = await sample([ANNOTATION_TYPE.toUpperCase()]);
    assert.equal(s.annotationVerts, 0);
    assert.ok(s.gridVerts > 0);
  });

  it('hides nothing for a class the overlay does not draw', async () => {
    // The deliberate limit, pinned so it stays deliberate: the gate matches
    // the OWNER class of the overlay primitives. `IfcGrid` owns no overlay
    // primitive (its axes do), and a wall named here keeps its `Axis`
    // representation, which the overlay filter never parsed in the first
    // place. Both are documented on `hideTypes` in the embed SDK.
    for (const notDrawn of ['IfcGrid', 'IfcWall']) {
      const s = await sample([notDrawn]);
      assert.ok(s.annotationVerts > 0, `${notDrawn} must not blank the annotation channel`);
      assert.ok(s.gridVerts > 0, `${notDrawn} must not blank the grid channel`);
    }
  });
});
