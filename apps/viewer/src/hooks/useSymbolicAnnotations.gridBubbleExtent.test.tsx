/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Grid BUBBLES must not grow the scene AABB (issue #3359, the second half).
 *
 * The renderer decides whether an upload grows the scene AABB by CHANNEL:
 * `annotation` does, `grid` deliberately does not, because grid axes reach past
 * the model envelope and reframing on them throws the model off screen (#967).
 * This hook used to lift IfcGridAxis lines into the SAME array it returned for
 * the `annotation` channel, so with "Show IFC Annotations" off and the IfcGrid
 * toggle on, the buffer reaching `setLineOverlay('annotation', …)` held nothing
 * but grid lines — and the camera reframed on grid extent, which is exactly the
 * outcome `grid: false` exists to prevent.
 *
 * These render the real hook over a real parse result and assert which array
 * each primitive lands in. The bounds consequence itself is asserted on the
 * renderer side (`renderer-symbolic-extent.test.ts`,
 * `renderer-overlays-line-channels.test.ts`), which is where the host calls are
 * observable.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { __setOverlayWorkerFactoryForTest } from '@/lib/overlay-parse/index.js';
import { createEmptyFlatSymbolic, type FlatSymbolic } from '@/lib/overlay-parse/symbolic-flat.js';
import { __resetSymbolicAnnotationsCacheForTests } from './symbolic-parse-cache.js';
import {
  useSymbolicAnnotationsRichData,
  type AnnotationText3D,
  type AnnotationFill3D,
  type SectionClipForGrid,
} from './useSymbolicAnnotations.js';

/** X coordinate of the annotation segment, so the two are told apart by value. */
const ANNOTATION_X = 1;
/** The grid axis sits far out, the way a real grid does. */
const GRID_X = 1000;

/**
 * One IfcAnnotation polyline and one IfcGridAxis polyline, plus one label and
 * one fill each.
 * `polyWorldY` / `textWorldY` are NaN and the store carries no spatial
 * hierarchy, so everything lands in the loose buckets — the storey resolution
 * is a different subject with its own tests.
 */
/**
 * `storeyY` finite routes every primitive into the byStorey buckets; NaN sends
 * them to the loose ones. Both matter: `symbolic-parse` picks the bucket on
 * `Number.isFinite(primitiveWorldY)`, and the hook walks the two collections
 * through SEPARATE loops. The NaN default covers the loose half; the finite
 * variant covers the bucket half, which is the path a model with resolvable
 * storey elevations takes -- i.e. most of them.
 */
function annotationAndGrid(storeyY = NaN): FlatSymbolic {
  const f = createEmptyFlatSymbolic();
  f.typeNames = ['IfcAnnotation', 'IfcGridAxis'];

  f.polyPoints = Float32Array.from([
    ANNOTATION_X, 0, ANNOTATION_X, 1,
    GRID_X, 0, GRID_X, 1,
  ]);
  f.polyStart = Uint32Array.from([0, 2, 4]);
  f.polyOwner = Uint32Array.from([2, 3]);
  f.polyWorldY = Float32Array.from([storeyY, storeyY]);
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
  f.textWorldY = Float32Array.from([storeyY, storeyY]);
  f.textType = Uint16Array.from([0, 1]);

  // One fill per kind. The grid one stands in for a bubble disc, which is the
  // outermost grid content there is, so it is the fill that must waive extent.
  f.fillPoints = Float32Array.from([
    ANNOTATION_X, 0, ANNOTATION_X, 1, ANNOTATION_X + 1, 1,
    GRID_X, 0, GRID_X, 1, GRID_X + 1, 1,
  ]);
  // Offsets are FLOAT indices into fillPoints, not vertex indices: the reader
  // does fillPoints.slice(start[i], start[i + 1]). Three [x,z] pairs = 6 floats.
  f.fillPointStart = Uint32Array.from([0, 6, 12]);
  f.fillHoles = new Uint32Array(0);
  f.fillHoleStart = Uint32Array.from([0, 0, 0]);
  f.fillColor = new Float32Array(8);
  f.fillHatch = new Float32Array(8);
  f.fillOwner = Uint32Array.from([2, 3]);
  f.fillWorldY = Float32Array.from([storeyY, storeyY]);
  f.fillFlags = Uint8Array.from([0, 0]);
  f.fillType = Uint16Array.from([0, 1]);

  return f;
}

/**
 * The `contentKey` CARRIES the fixture, and that is load-bearing (issue #3393).
 *
 * `symbolic-parse-cache.ts` keys its module-global parse cache on
 * `source.contentKey` plus the elevation rebase, and `ensureParseFor` returns
 * early when that key is already cached or in flight. The worker stub below is
 * the only thing that knows which fixture a `sample()` call wants, and it is
 * NOT part of that key — so with one shared key, re-installing the worker to
 * change fixtures does nothing once a parse for that key has started: the
 * second call silently reads the FIRST fixture back.
 *
 * That is measured, not defensive. With a single shared key, two `sample()`
 * calls in one test served the second one the first one's NaN parse, which
 * puts every grid primitive in `gridLoose*` and leaves `gridByStorey` empty —
 * so a section-clip band check over `gridByStorey` guards a zero-iteration
 * loop and an out-of-band case comes back empty whether the band check exists
 * or not. That is exactly the vacuous pair #3393 was filed for.
 */
function store(storeyY = NaN): IfcDataStore {
  return {
    source: {
      contentKey: `grid-channel-bytes-${storeyY}`,
      byteLength: 10,
      toTransferable: () => ({}),
    },
  } as unknown as IfcDataStore;
}

/** A worker stand-in that answers every request with the fixture above. */
function installWorker(storeyY = NaN): () => void {
  const previous = __setOverlayWorkerFactoryForTest(() => {
    const worker = {
      postMessage(request: { id: number }) {
        setTimeout(() => {
          worker.onmessage?.({ data: { id: request.id, ok: true, flat: annotationAndGrid(storeyY) } });
        }, 0);
      },
      terminate() {},
      onmessage: null as ((event: { data: unknown }) => void) | null,
    };
    return worker as unknown as Worker;
  });
  return () => { __setOverlayWorkerFactoryForTest(previous); };
}

interface Sample {
  texts: readonly AnnotationText3D[];
  fills: readonly AnnotationFill3D[];
}

let root: Root | null = null;
let container: HTMLElement | null = null;
/** Set when a test re-installs the worker with resolvable storey elevations. */
let restoreStoreyWorker: (() => void) | null = null;

/**
 * Mount the two hooks with the given toggles and let the parse land. Returns
 * what the last render produced.
 */
async function sample(
  toggles: { enabled: boolean; gridEnabled: boolean },
  storeyY = NaN,
  hookOpts: { fallbackY?: number; gridSectionClip?: SectionClipForGrid } = {},
): Promise<Sample> {
  let latest: Sample | null = null;

  // Tear the previous mount down FIRST, before anything below touches the
  // store. `root` / `container` are single slots and `afterEach` unmounts only
  // what they point at LAST, so without this a Probe from an earlier
  // `sample()` stays subscribed to the store and the parse cache and
  // re-renders outside `act()` — into the tests that follow, since nothing
  // ever unmounts it. Doing it before the `setState` below is what keeps that
  // store write from reaching a live Probe unwrapped.
  if (root && container) {
    const staleRoot = root;
    const staleContainer = container;
    act(() => staleRoot.unmount());
    staleContainer.remove();
    root = null;
    container = null;
  }

  if (Number.isFinite(storeyY)) {
    restoreStoreyWorker?.();
    restoreStoreyWorker = installWorker(storeyY);
    // Point the hooks at a store whose contentKey names THIS fixture, so the
    // parse cache cannot answer with the one installed before it. See `store`.
    useViewerStore.setState({ ifcDataStore: store(storeyY) } as never);
  }

  function Probe(): null {
    const rich = useSymbolicAnnotationsRichData({
      enabled: toggles.enabled,
      gridEnabled: toggles.gridEnabled,
      ...hookOpts,
    });
    latest = { texts: rich.texts, fills: rich.fills };
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


describe('grid bubbles draw without defining the model extent (issue 3359)', () => {
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
    restoreStoreyWorker?.();
    restoreStoreyWorker = null;
    restoreWorker?.();
    restoreWorker = null;
  });

  it('annotations OFF, grid ON: the bubble draws but waives extent', async () => {
    // The reported case. Routing the grid LINES to the `grid` channel does not
    // reach here: texts and fills carry no channel, so before `definesExtent`
    // they grew the bounds unconditionally and the camera still reframed on
    // grid extent -- on the outermost grid content there is.
    const s = await sample({ enabled: false, gridEnabled: true });

    assert.equal(s.texts.length, 1, 'the grid bubble label must still draw');
    assert.equal(s.texts[0].content, 'A');
    assert.equal(s.texts[0].definesExtent, false);
    assert.equal(s.fills.length, 1, 'the grid bubble fill must still draw');
    assert.equal(s.fills[0].definesExtent, false);
  });

  it('both ON: the flag tracks WHICH branch pushed the item', async () => {
    // The discriminating case. A flag that were merely false whenever a grid
    // exists would pass the test above and fail this one.
    const s = await sample({ enabled: true, gridEnabled: true });

    assert.equal(s.texts.length, 2, 'both labels draw');
    assert.deepEqual(
      [...s.texts].map((t) => t.definesExtent).sort(),
      [false, true],
      'the annotation label defines extent, the grid bubble does not',
    );
    assert.equal(s.fills.length, 2, 'both fills draw');
    assert.deepEqual(
      [...s.fills].map((f) => f.definesExtent).sort(),
      [false, true],
      'same for the fill half, which travels a separate push path',
    );
  });

  it('a CLIPPED grid lift still waives extent', async () => {
    // The clipped branch is a separate copy of the push loop, and nothing in
    // the repo passed `gridSectionClip` before this, so four of the twelve push
    // sites were unreachable by any test: flipping one of them to
    // pushAnnotationText left the whole suite green while handing a
    // section-clipped plan view #3359 straight back.
    //
    // Asserts the FLAG on a produced item rather than its presence or absence.
    // An earlier attempt asserted in/out-of-band membership and passed with the
    // band check deleted, because the loose-bucket guard was deciding the
    // outcome, not the band (#3393). Reading the flag off an item that is
    // definitely there has no such confound.
    const s = await sample({ enabled: false, gridEnabled: true }, 3, {
      fallbackY: 3,
      gridSectionClip: { enabled: true, axis: 'down', posWorld: 3, viewDepth: 5 },
    });

    assert.equal(s.texts.length, 1, 'the fixture must reach the clipped branch at all');
    assert.equal(s.texts[0].definesExtent, false);
    assert.equal(s.fills.length, 1);
    assert.equal(s.fills[0].definesExtent, false);
  });

  it('only an ENABLED, DOWN cut clips — the derivation, not just the band (issues #862, #3393)', async () => {
    // `clipEnabled` is DERIVED inside both hooks, never passed in:
    //   !!gridSectionClip && gridSectionClip.enabled && gridSectionClip.axis === 'down'
    // The pure-seam cases in `symbolic-grid-section-clip.test.ts` take
    // `clipEnabled` as a literal, so they structurally cannot reach that line;
    // rewriting it to `!!gridSectionClip` left the whole suite green.
    //
    // Not a live app bug today: `Viewport.tsx` is the only producer and it
    // returns `undefined` unless the cut is enabled and `axis === 'down'`, so
    // the two conjuncts are unreachable-false through the app. They are the
    // hook's PUBLISHED contract for any other caller — `SectionClipForGrid`
    // documents both — and that contract had no test.
    //
    // The band [2, 4] excludes the loose fixture's `fallbackY` of 0, so the
    // clipping arm is observably EMPTY. Each non-clipping arm runs the SAME
    // fixture and is observably non-empty, which is what rules out "the content
    // never arrived" as the reason for the empty one — the confound that made
    // the first attempt at #3393 vacuous.
    const cut = { posWorld: 3, viewDepth: 1 };

    const sideCut = await sample({ enabled: false, gridEnabled: true }, NaN, {
      gridSectionClip: { ...cut, enabled: true, axis: 'front' },
    });
    assert.equal(sideCut.texts.length, 1, 'a front cut passes grid content through unfiltered');

    const offCut = await sample({ enabled: false, gridEnabled: true }, NaN, {
      gridSectionClip: { ...cut, enabled: false, axis: 'down' },
    });
    assert.equal(offCut.texts.length, 1, 'and so does a down cut that is not enabled');

    const downCut = await sample({ enabled: false, gridEnabled: true }, NaN, {
      gridSectionClip: { ...cut, enabled: true, axis: 'down' },
    });
    assert.equal(
      downCut.texts.length,
      0,
      'only the enabled down cut clips; a truthy-only derivation makes all three of these 0',
    );
  });

  it('a second source in one test is parsed on its own, not answered from the first', async () => {
    // The trap that made #3393's first attempt vacuous, turned into a gate.
    //
    // `ensureParseFor` skips a store whose cache key is already cached or in
    // flight (`symbolic-parse-cache.ts`), and the key is the source's
    // `contentKey` plus the elevation rebase — never the worker stub that
    // actually holds the fixture. So a second `sample()` in one test reads the
    // FIRST fixture back unless the two sources are distinct, which is the
    // same staleness that hid a federated model's annotations in #2183.
    //
    // Read on the ELEVATION rather than on presence: the NaN fixture lifts its
    // bubble to `fallbackY` (0) and the finite one to its own storey (3), so a
    // stale answer is a wrong NUMBER here, not an empty list that a filter
    // somewhere upstream could also explain.
    const loose = await sample({ enabled: false, gridEnabled: true }, NaN);
    assert.deepEqual(loose.texts.map((t) => t.worldPos[1]), [0], 'the NaN fixture lifts to fallbackY');

    const bucketed = await sample({ enabled: false, gridEnabled: true }, 3);
    assert.deepEqual(
      bucketed.texts.map((t) => t.worldPos[1]),
      [3],
      'the second fixture must reach the parse; 0 here means the first parse was reused',
    );
  });

  it('the same split holds for content that RESOLVES to a storey bucket', async () => {
    // Everything above leaves world-Y as NaN, which lands in the LOOSE buckets.
    // `symbolic-parse` routes on `Number.isFinite(primitiveWorldY)` and the hook
    // walks byStorey and loose through separate loops, so without this a
    // regression on the bucket path -- the one a model with resolvable storey
    // elevations takes -- would be green.
    const s = await sample({ enabled: false, gridEnabled: true }, 3);

    assert.equal(s.texts.length, 1);
    assert.equal(s.texts[0].definesExtent, false);
    assert.equal(s.fills.length, 1);
    assert.equal(s.fills[0].definesExtent, false);
  });
});
