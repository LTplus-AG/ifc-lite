/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Source compaction after load (#2183). The compressor is the parser's real
 * `compressSource`, run in-process instead of in a Worker, with a small block
 * size so a few-KB STEP text spans many blocks. What is asserted is the
 * contract the viewer relies on: reads through the SAME accessor object return
 * the same bytes after the swap, the content key does not change (overlay and
 * cache keys hang off it), and a failed compression leaves the source exactly
 * as readable as before.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compressSource,
  contiguousSourceBytes,
  sourceBytesFromTransferable,
  type CompressedSource,
} from '@ifc-lite/parser';
import { compactSource, type SourceCompressor } from './source-compaction.js';
import { shareCompressedBlocks } from './shared-blocks.js';

const ALWAYS = () => true;

/** A STEP-shaped source in a SharedArrayBuffer, as the loader holds it. */
function sharedSource(lines = 400): { bytes: Uint8Array; text: string } {
  const rows = ['ISO-10303-21;', 'HEADER;', 'ENDSEC;', 'DATA;'];
  for (let i = 1; i <= lines; i++) rows.push(`#${i}=IFCWALL('guid${i}',$,'Wall ${i}',$,$,$,$,$,$);`);
  rows.push('ENDSEC;', 'END-ISO-10303-21;');
  const text = rows.join('\n');
  const encoded = new TextEncoder().encode(text);
  const bytes = new Uint8Array(new SharedArrayBuffer(encoded.byteLength));
  bytes.set(encoded);
  return { bytes, text };
}

/** What the worker does, in-process: deflate, then share the blocks. */
const inProcess = (blockSize = 512): SourceCompressor => async (bytes) =>
  shareCompressedBlocks(compressSource(bytes, blockSize));

describe('compactSource', () => {
  it('swaps the same accessor to blocks; every read and the content key are unchanged', async () => {
    const { bytes, text } = sharedSource();
    const source = contiguousSourceBytes(bytes);
    const keyBefore = source.contentKey;
    const probes: Array<[number, number]> = [[0, 13], [500, 1800], [text.length - 40, text.length], [511, 513]];
    const before = probes.map(([s, e]) => source.decodeUtf8(s, e));

    assert.equal(await compactSource(source, { compress: inProcess(), shouldCompress: ALWAYS }), 'compacted');

    assert.equal(source.isResident, false, 'the store no longer holds the resident view');
    assert.equal(source.byteLength, bytes.byteLength);
    assert.equal(source.contentKey, keyBefore, 'cache and overlay keys must survive the swap');
    assert.deepEqual(probes.map(([s, e]) => source.decodeUtf8(s, e)), before);
    assert.equal(source.withMaterialized((all) => new TextDecoder().decode(all.slice())), text);
  });

  it('hands workers shared blocks after the swap, which rebuild to the same bytes', async () => {
    const { bytes, text } = sharedSource();
    const source = contiguousSourceBytes(bytes);
    await compactSource(source, { compress: inProcess(), shouldCompress: ALWAYS });
    const transfer = source.toTransferable();
    assert.equal(transfer.kind, 'blocked');
    if (transfer.kind !== 'blocked') return;
    assert.ok(transfer.blocks.buffer instanceof SharedArrayBuffer,
      'an overlay parse must receive the blocks by reference, not as a structured clone');
    const rebuilt = sourceBytesFromTransferable(transfer);
    assert.equal(rebuilt.decodeUtf8(0, rebuilt.byteLength), text);
  });

  it('leaves small sources resident (size gate)', async () => {
    const { bytes } = sharedSource(4);
    const source = contiguousSourceBytes(bytes);
    let calls = 0;
    const compress: SourceCompressor = async (b) => { calls++; return compressSource(b, 512); };
    assert.equal(await compactSource(source, { compress }), 'skipped', 'a few-KB source is below the default floor');
    assert.equal(calls, 0);
    assert.equal(source.isResident, true);
  });

  it('runs one compression per source even when asked twice before it finishes', async () => {
    const { bytes } = sharedSource();
    const source = contiguousSourceBytes(bytes);
    let calls = 0;
    const compress: SourceCompressor = async (b) => { calls++; return compressSource(b, 512); };
    const [first, second] = await Promise.all([
      compactSource(source, { compress, shouldCompress: ALWAYS }),
      compactSource(source, { compress, shouldCompress: ALWAYS }),
    ]);
    assert.deepEqual([first, second], ['compacted', 'skipped']);
    assert.equal(calls, 1);
    assert.equal(await compactSource(source, { compress, shouldCompress: ALWAYS }), 'skipped',
      'an already-compacted source is not compressed again');
  });

  it('runs compressions one at a time across models', async () => {
    let running = 0;
    let peak = 0;
    const compress: SourceCompressor = async (b) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return compressSource(b, 512);
    };
    const sources = [sharedSource(), sharedSource(), sharedSource()].map(({ bytes }) => contiguousSourceBytes(bytes));
    const outcomes = await Promise.all(sources.map((s) => compactSource(s, { compress, shouldCompress: ALWAYS })));
    assert.deepEqual(outcomes, ['compacted', 'compacted', 'compacted']);
    assert.equal(peak, 1, 'a federation must not stack every compression at once');
  });

  it('keeps the source resident and readable when compression fails', async () => {
    const { bytes, text } = sharedSource();
    const source = contiguousSourceBytes(bytes);
    const warnings: unknown[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const failing: SourceCompressor = async () => { throw new Error('worker died'); };
      assert.equal(await compactSource(source, { compress: failing, shouldCompress: ALWAYS }), 'failed');
      const wrong: SourceCompressor = async (): Promise<CompressedSource> => compressSource(bytes.subarray(1), 512);
      assert.equal(await compactSource(source, { compress: wrong, shouldCompress: ALWAYS }), 'failed',
        'blocks for different bytes must be refused, never swapped in');
    } finally {
      console.warn = realWarn;
    }
    assert.equal(warnings.length, 2, 'each failure is reported');
    assert.equal(source.isResident, true);
    assert.equal(source.decodeUtf8(0, source.byteLength), text);
  });
});
