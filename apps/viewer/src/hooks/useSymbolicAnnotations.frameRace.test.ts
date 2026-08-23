/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A cached `ParseResult` must be rebased for the frame its KEY names.
 *
 * `useSymbolicAnnotations.cacheKeyFrame.test.ts` pins the mechanism — that
 * `sourceKey` derives the key from the frame it is handed. This pins the
 * damage, which is a different thing: the key can be perfectly correct while
 * the VALUE filed under it was rebased for another frame entirely. That is
 * what happens if the frame is read once to build the key and again after the
 * parse await resolves, and no assertion about keys can see it.
 *
 * The window only exists across the await, so the test holds the worker reply
 * open, re-aligns, and only then lets the parse finish.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '../store/index.js';
import { __setOverlayWorkerFactoryForTest } from '../lib/overlay-parse/index.js';
import { createEmptyFlatSymbolic } from '../lib/overlay-parse/symbolic-flat.js';
import {
  ensureParseFor,
  getParseFor,
  __resetSymbolicAnnotationsCacheForTests,
  __symbolicAnnotationsSourceKeyForTests,
} from './symbolic-parse-cache.js';

/** Raw `IfcBuildingStorey.Elevation`, the value the storey-table rebase acts on. */
const TABLE_ELEVATION = 415;
const RTC_Z = 407;
const SHIFT_A = 2.5;
const SHIFT_B = 50;

/** One annotation polyline owned by express id 2, with no primitive worldY, so
 *  the bucket falls back to the storey table — the path the rebase touches. */
function oneAnnotation(): ReturnType<typeof createEmptyFlatSymbolic> {
  const f = createEmptyFlatSymbolic();
  f.typeNames = ['IfcAnnotation'];
  f.polyPoints = Float32Array.from([0, 0, 1, 0]);
  f.polyStart = Uint32Array.from([0, 2]);
  f.polyOwner = Uint32Array.from([2]);
  f.polyWorldY = Float32Array.from([NaN]);
  f.polyFlags = Uint8Array.from([0]);
  f.polyType = Uint16Array.from([0]);
  return f;
}

function store(): IfcDataStore {
  return {
    source: { contentKey: 'race-bytes', byteLength: 10, toTransferable: () => ({}) },
    spatialHierarchy: {
      elementToStorey: new Map([[2, 90]]),
      storeyElevations: new Map([[90, TABLE_ELEVATION]]),
    },
  } as unknown as IfcDataStore;
}

function setFrame(shiftY: number): void {
  useViewerStore.setState({
    geometryResult: {
      coordinateInfo: {
        originShift: { x: 0, y: shiftY, z: 0 },
        wasmRtcOffset: { x: 0, y: 0, z: RTC_Z },
      },
    },
  } as never);
}

interface HeldWorker {
  postMessage(request: { id: number }): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

describe('a result filed under one frame is not rebased for another', () => {
  beforeEach(() => {
    __resetSymbolicAnnotationsCacheForTests();
  });

  it('survives a re-align that lands during the parse await', async () => {
    let worker: HeldWorker | null = null;
    let request: { id: number } | null = null;
    const previous = __setOverlayWorkerFactoryForTest(() => {
      // Holds the reply instead of answering, so the test owns the moment the
      // await resolves.
      worker = {
        postMessage(r) { request = r; },
        terminate() {},
        onmessage: null,
      };
      return worker as unknown as Worker;
    });

    try {
      const s = store();
      setFrame(SHIFT_A);
      const keyA = __symbolicAnnotationsSourceKeyForTests(s);
      const [parse] = ensureParseFor([s]);
      await new Promise((r) => setTimeout(r, 0)); // let dispatch post the request
      // Cast through the union: both are assigned inside the factory closure,
      // which control-flow analysis cannot see, so it narrows them to `null`.
      const posted = request as { id: number } | null;
      const live = worker as HeldWorker | null;
      assert.ok(posted, 'the worker never received a request; the parse never started');
      assert.ok(live, 'no worker was created');

      // Re-align WHILE the parse is in flight, then release it.
      setFrame(SHIFT_B);
      live.onmessage?.({ data: { id: posted.id, ok: true, flat: oneAnnotation() } });
      await parse;

      // Read the entry back under frame A, the frame it was keyed for.
      setFrame(SHIFT_A);
      const cached = getParseFor(s);
      assert.ok(cached, `nothing cached under frame-A key ${keyA}`);
      const buckets = [...cached.byStorey.values()];
      assert.equal(buckets.length, 1, 'expected exactly one storey bucket');

      const expected = TABLE_ELEVATION - RTC_Z - SHIFT_A;
      assert.ok(
        Math.abs(buckets[0].storeyElevation! - expected) < 1e-6,
        `the entry under frame A's key was rebased for a different frame: expected `
          + `${expected}, got ${buckets[0].storeyElevation}. A render returning to frame A `
          + `would draw every annotation at the wrong elevation, from cache.`,
      );
    } finally {
      __setOverlayWorkerFactoryForTest(previous);
    }
  });
});
