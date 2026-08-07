/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The worker handoff must DESCRIBE the source, never materialize it (#2183).
 *
 * This function is the one seam between a loaded model and the bytes a worker
 * parse receives. Materializing here is the single worst place to do it: it
 * would allocate the whole file on the render thread, which is exactly the
 * 327 MB allocation the issue exists to remove — and it would do it every time
 * an overlay re-parses, not once.
 *
 * The failure is silent. A source that materializes still produces correct
 * overlays, correct drawings and correct IDS results; it just costs a few
 * hundred megabytes nobody attributes to it. So the contract is pinned
 * directly: a source that refuses to hand over all its bytes must still be
 * handoff-able.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { contiguousSourceBytes, type IfcSourceBytes } from '@ifc-lite/parser';

import { getWholeSourceForWorker } from './source-handoff.js';

const BYTES = new TextEncoder().encode("#1=IFCWALL('a',$,'W',$);\n#2=IFCSLAB('b',$);\n");

/**
 * A source that throws if anyone asks for all of it.
 *
 * An explicit delegate rather than a `Proxy`: the real accessor reads
 * `#private` fields in its getters, and behind a proxy those run with `this`
 * bound to the proxy, so every read would throw for the wrong reason and the
 * test would pass against a materializing implementation too.
 */
function refusesToMaterialize(): IfcSourceBytes {
  const inner = contiguousSourceBytes(BYTES);
  const refuse = (via: string) => (): never => {
    throw new Error(`getWholeSourceForWorker materialized the source via ${via}`);
  };
  // Refusing `materialize` is NOT enough. `slice(0, byteLength)` is the same
  // whole-file allocation by another name, and for a compressed source it
  // inflates everything just as surely -- so an implementation spelled that
  // way passed all four of these. Bound the read as well as the materialize.
  const boundedSlice = (start: number, end: number): Uint8Array => {
    if (end - start >= inner.byteLength) {
      throw new Error(
        `getWholeSourceForWorker read the whole source via slice(${start}, ${end})`,
      );
    }
    return inner.slice(start, end);
  };
  return {
    get byteLength() { return inner.byteLength; },
    get length() { return inner.length; },
    get isResident() { return inner.isResident; },
    get contentKey() { return inner.contentKey; },
    slice: boundedSlice,
    decodeUtf8: (a, b) => inner.decodeUtf8(a, b),
    materialize: refuse('materialize'),
    withMaterialized: refuse('withMaterialized'),
    withMaterializedAsync: refuse('withMaterializedAsync'),
    toTransferable: () => inner.toTransferable(),
  };
}

describe('getWholeSourceForWorker (#2183)', () => {
  it('describes the source without materializing it', () => {
    const transfer = getWholeSourceForWorker({ source: refusesToMaterialize() });
    assert.equal(transfer.kind, 'contiguous');
  });

  it('shares a resident source BY REFERENCE, so the handoff stays free', () => {
    // The source is SharedArrayBuffer-backed on the paths that matter, and a
    // SAB posted without a transfer list is shared rather than copied. If this
    // ever became a copy, every overlay re-parse would duplicate the file.
    const source = contiguousSourceBytes(BYTES);
    const transfer = getWholeSourceForWorker({ source });
    assert.equal(transfer.kind, 'contiguous');
    if (transfer.kind !== 'contiguous') return;
    assert.strictEqual(transfer.bytes.buffer, BYTES.buffer, 'the handoff copied the source');
    assert.equal(transfer.bytes.byteLength, BYTES.byteLength);
  });

  it('carries an already-computed content key across, and does not force one', () => {
    // Forcing the key here would walk the whole file on the render thread,
    // which is the same class of cost as materializing.
    const fresh = contiguousSourceBytes(BYTES);
    const before = getWholeSourceForWorker({ source: fresh });
    assert.equal(before.contentKey, null, 'the handoff forced a full-file hash');

    // Once something else has computed it, it rides along rather than making
    // the receiving thread walk again.
    const key = fresh.contentKey;
    const after = getWholeSourceForWorker({ source: fresh });
    assert.equal(after.contentKey, key);
  });

  it('round-trips to bytes identical to the source', async () => {
    const { sourceBytesFromTransferable } = await import('@ifc-lite/parser');
    const transfer = getWholeSourceForWorker({ source: contiguousSourceBytes(BYTES) });
    const rebuilt = sourceBytesFromTransferable(transfer);
    assert.deepEqual(Array.from(rebuilt.materialize()), Array.from(BYTES));
    assert.equal(rebuilt.decodeUtf8(0, 12), '#1=IFCWALL(\'');
  });
});
