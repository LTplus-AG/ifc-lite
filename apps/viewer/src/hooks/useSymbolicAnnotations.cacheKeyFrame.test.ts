/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The parse cache stores a `ParseResult` with the elevation rebase already
 * baked in, so the key has to name the frame as well as the bytes.
 *
 * The RTC part of that rebase IS a function of the source bytes — it is the
 * median of the model's own placements — which is why keying on `contentKey`
 * alone was correct before the rebase existed. `originShift` is not: it is set
 * per model by federation and by re-alignment. Two models loaded from
 * identical bytes at different placements therefore share a `contentKey` and
 * need different results.
 *
 * What this does NOT cover: whether the rebase itself is right (that is
 * `symbolic_rtc_frame.rs` and the elevation-frame suite), and whether a
 * re-alignment triggers a re-parse at all — only that if it does, the two
 * frames cannot collide in the cache.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '../store/index.js';
import { __symbolicAnnotationsSourceKeyForTests } from './symbolic-parse-cache.js';

/** Same bytes, same content hash — the case the old key could not separate. */
function store(): IfcDataStore {
  return {
    source: { contentKey: 'identical-bytes', byteLength: 10 },
  } as unknown as IfcDataStore;
}

function setFrame(target: IfcDataStore, originShiftY: number, rtcZ: number): void {
  useViewerStore.setState({
    models: new Map(),
    ifcDataStore: target,
    loading: false,
    geometryResult: {
      coordinateInfo: {
        originShift: { x: 0, y: originShiftY, z: 0 },
        wasmRtcOffset: { x: 0, y: 0, z: rtcZ },
        wasmRtcFrame: { x: 0, y: 0, z: rtcZ, needsShift: true },
      },
    },
  } as never);
}

describe('symbolic parse cache key carries the render frame', () => {
  beforeEach(() => {
    useViewerStore.setState({ models: new Map(), ifcDataStore: null, geometryResult: null, loading: false });
  });

  it('separates two placements of identical source bytes', () => {
    const a = store();
    setFrame(a, 2.5, 407);
    const atA = __symbolicAnnotationsSourceKeyForTests(a);
    const b = store();
    setFrame(b, -11.25, 407);
    const atB = __symbolicAnnotationsSourceKeyForTests(b);

    assert.ok(atA && atB, 'both keys must be derivable');
    assert.notEqual(
      atA,
      atB,
      'same bytes at a different originShift must not share a cache entry',
    );
    // Both still name the source, so the key did not simply become opaque.
    assert.ok(atA.startsWith('identical-bytes|'), atA);
    assert.ok(atB.startsWith('identical-bytes|'), atB);
  });

  it('is stable for the same frame, so nothing re-parses every tick', () => {
    const target = store();
    setFrame(target, 2.5, 407);
    assert.equal(
      __symbolicAnnotationsSourceKeyForTests(target),
      __symbolicAnnotationsSourceKeyForTests(target),
    );
  });

  it('separates a pure RTC difference too, not only originShift', () => {
    // The primitive rebase is `total - rtcZ`, which cancels rtcZ; the storey
    // table rebase keeps it. Distinct rtcZ with a shared originShift is what
    // tells the two halves apart — a key built from the primitive value alone
    // would collide here.
    const target = store();
    setFrame(target, 2.5, 407);
    const a = __symbolicAnnotationsSourceKeyForTests(target);
    setFrame(target, 2.5, 415);
    const b = __symbolicAnnotationsSourceKeyForTests(target);
    assert.notEqual(a, b, 'the storey-table half of the frame must be keyed too');
  });

  it('distinguishes an explicit zero frame from absent provenance', () => {
    // Numeric equality is not enough: explicit producer provenance means use
    // this exact frame, while absence means run standalone detection.
    const target = store();
    setFrame(target, 0, 0);
    const zero = __symbolicAnnotationsSourceKeyForTests(target);
    useViewerStore.setState({ geometryResult: null } as never);
    assert.notEqual(zero, __symbolicAnnotationsSourceKeyForTests(target));
  });

  it('does not inherit an active sibling frame when the owning model has no coordinate info', () => {
    const target = store();
    const sibling = store();
    useViewerStore.setState({
      ifcDataStore: sibling,
      loading: false,
      geometryResult: {
        coordinateInfo: {
          originShift: { x: 0, y: 99, z: 0 },
          wasmRtcOffset: { x: 0, y: 0, z: 50 },
          wasmRtcFrame: { x: 0, y: 0, z: 50, needsShift: true },
        },
      },
      models: new Map([['target', {
        ifcDataStore: target,
        geometryResult: null,
        loadState: 'complete',
      } as never]]),
    } as never);

    assert.equal(
      __symbolicAnnotationsSourceKeyForTests(target),
      'identical-bytes|standalone|0|0',
    );
  });
});

describe('sourceKey derives the key from the frame it is GIVEN', () => {
  it('ignores an ambient frame change, so two reads cannot diverge', () => {
    const s = store();
    const frame = { primitive: 3, storeyTable: 7 };

    setFrame(s, 10, 0);
    const before = __symbolicAnnotationsSourceKeyForTests(s, frame);
    // Re-align. A key built from the passed frame must not move; one built by
    // reading ambient state would, which is exactly how a result rebased on
    // one side of an await gets filed under the other side's key.
    setFrame(s, 99, 0);
    const after = __symbolicAnnotationsSourceKeyForTests(s, frame);

    assert.equal(after, before, 'the key moved with ambient state despite a fixed frame');
    // And the frame genuinely reaches the key, or the assertion above is
    // satisfied by a key that ignores the frame altogether.
    assert.notEqual(
      __symbolicAnnotationsSourceKeyForTests(s, { primitive: 4, storeyTable: 7 }),
      before,
      'a different frame produced the same key; the frame is not in the key',
    );
  });
});
