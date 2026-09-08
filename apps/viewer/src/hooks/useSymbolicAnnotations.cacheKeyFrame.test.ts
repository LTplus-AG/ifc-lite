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

function setFrame(originShiftY: number, rtcZ: number): void {
  useViewerStore.setState({
    geometryResult: {
      coordinateInfo: {
        originShift: { x: 0, y: originShiftY, z: 0 },
        wasmRtcOffset: { x: 0, y: 0, z: rtcZ },
      },
    },
  } as never);
}

describe('symbolic parse cache key carries the render frame', () => {
  beforeEach(() => {
    setFrame(0, 0);
  });

  it('separates two placements of identical source bytes', () => {
    setFrame(2.5, 407);
    const atA = __symbolicAnnotationsSourceKeyForTests(store());
    setFrame(-11.25, 407);
    const atB = __symbolicAnnotationsSourceKeyForTests(store());

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
    setFrame(2.5, 407);
    assert.equal(
      __symbolicAnnotationsSourceKeyForTests(store()),
      __symbolicAnnotationsSourceKeyForTests(store()),
    );
  });

  it('separates a pure RTC difference too, not only originShift', () => {
    // The primitive rebase is `total - rtcZ`, which cancels rtcZ; the storey
    // table rebase keeps it. Distinct rtcZ with a shared originShift is what
    // tells the two halves apart — a key built from the primitive value alone
    // would collide here.
    setFrame(2.5, 407);
    const a = __symbolicAnnotationsSourceKeyForTests(store());
    setFrame(2.5, 415);
    const b = __symbolicAnnotationsSourceKeyForTests(store());
    assert.notEqual(a, b, 'the storey-table half of the frame must be keyed too');
  });

  it('has no null offsets standing in for a real frame', () => {
    // A fixture at 0/0 cannot observe any of the above: it is the state the
    // absent-coordinateInfo fallback already produces.
    setFrame(0, 0);
    const zero = __symbolicAnnotationsSourceKeyForTests(store());
    useViewerStore.setState({ geometryResult: null } as never);
    assert.equal(zero, __symbolicAnnotationsSourceKeyForTests(store()));
  });
});

describe('sourceKey derives the key from the frame it is GIVEN', () => {
  it('ignores an ambient frame change, so two reads cannot diverge', () => {
    const s = store();
    const frame = { primitive: 3, storeyTable: 7 };

    setFrame(10, 0);
    const before = __symbolicAnnotationsSourceKeyForTests(s, frame);
    // Re-align. A key built from the passed frame must not move; one built by
    // reading ambient state would, which is exactly how a result rebased on
    // one side of an await gets filed under the other side's key.
    setFrame(99, 0);
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
