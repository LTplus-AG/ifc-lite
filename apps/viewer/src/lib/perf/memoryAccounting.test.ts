/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAccounting } from './memoryAccounting.js';

describe('MemoryAccounting', () => {
  it('tracks peak JS heap and per-phase records', () => {
    const acc = new MemoryAccounting();
    acc.reset();
    acc.setSourceBytes(50 * 1024 * 1024);
    acc.recordPhase({ phase: 'upload', jsHeapBytes: 80_000_000 });
    acc.recordPhase({ phase: 'parser-spawn', jsHeapBytes: 90_000_000 });
    acc.recordPhase({ phase: 'parser-complete', jsHeapBytes: 120_000_000 });

    const snap = acc.snapshot();
    assert.equal(snap.length, 3);
    assert.equal(snap[0].phase, 'upload');
    assert.equal(snap[2].jsHeapBytes, 120_000_000);

    const summary = acc.summary();
    assert.equal(summary.peakJsHeapBytes, 120_000_000);
    assert.equal(summary.sourceBytes, 50 * 1024 * 1024);
  });

  it('aggregates WASM heap across multiple workers using max value per worker', () => {
    const acc = new MemoryAccounting();
    acc.reset();
    acc.recordWorkerMemory('w0', 200_000_000);
    acc.recordWorkerMemory('w1', 180_000_000);
    acc.recordWorkerMemory('w2', 160_000_000);
    acc.recordPhase({ phase: 'geometry-complete' });

    const snap = acc.snapshot();
    // Sum of three workers (200 + 180 + 160) = 540 MB
    assert.equal(snap[0].wasmHeapBytes, 540_000_000);
  });

  it('accumulates geometry bytes across batches', () => {
    const acc = new MemoryAccounting();
    acc.reset();
    acc.addGeometryBytes(1_000_000);
    acc.addGeometryBytes(2_000_000);
    acc.addGeometryBytes(500_000);
    acc.recordPhase({ phase: 'geometry-complete' });
    assert.equal(acc.snapshot()[0].geometryBytes, 3_500_000);
  });

  it('computes parse/geometry overlap from phase ranges', async () => {
    const acc = new MemoryAccounting();
    acc.reset();
    // Two phases overlap by ~10 ms (use sleeps small enough to be reliable)
    acc.beginPhase('parser-worker');
    await new Promise(r => setTimeout(r, 10));
    acc.beginPhase('geometry');
    await new Promise(r => setTimeout(r, 20));
    acc.endPhase('parser-worker');
    await new Promise(r => setTimeout(r, 10));
    acc.endPhase('geometry');
    acc.recordPhase({ phase: 'done' });

    const summary = acc.summary();
    assert.ok(summary.parseGeometryOverlapMs > 5, `expected overlap > 5, got ${summary.parseGeometryOverlapMs}`);
    assert.ok(summary.parseGeometryOverlapMs < 200, `expected reasonable overlap, got ${summary.parseGeometryOverlapMs}`);
  });

  it('formatSummary produces a one-line summary', () => {
    const acc = new MemoryAccounting();
    acc.reset();
    acc.setSourceBytes(10 * 1024 * 1024);
    acc.recordPhase({ phase: 'done', jsHeapBytes: 50 * 1024 * 1024, geometryBytes: 5 * 1024 * 1024 });
    const line = acc.formatSummary();
    assert.match(line, /mem-summary/);
    assert.match(line, /peakJs=50\.0MB/);
    assert.match(line, /source=10\.0MB/);
  });

  it('reset() clears all state between loads', () => {
    const acc = new MemoryAccounting();
    acc.reset();
    acc.setSourceBytes(100);
    acc.recordPhase({ phase: 'first' });
    acc.reset();
    acc.recordPhase({ phase: 'second' });
    const snap = acc.snapshot();
    assert.equal(snap.length, 1);
    assert.equal(snap[0].phase, 'second');
    assert.equal(acc.summary().sourceBytes, 0);
  });
});
