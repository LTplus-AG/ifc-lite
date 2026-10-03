/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tsImport } from 'tsx/esm/api';
const { diagnosticEvent, frozenBeforeTeardown, boundedDiagnostic, writeAtomicEvidence,
  refusedRendererSnapshot } = await tsImport('./interleaved-diagnostics.ts', import.meta.url);

test('#6537 diagnostic events preserve observer delivery time and loading versus teardown attribution', () => {
  const loading = diagnosticEvent('console', 'Device lost', 'load-and-readiness', 1000, 1250);
  const teardown = diagnosticEvent('pageerror', 'Device destroyed', 'teardown', 1000, 1800);
  assert.equal(Date.parse(loading.capturedUTC), 1250);
  assert.equal(loading.elapsedMs, 250);
  assert.equal(teardown.elapsedMs - loading.elapsedMs, 550);
  assert.notEqual(loading.phase, teardown.phase);
});
test('#6537 partial evidence-write failure preserves the prior refusal and removes only its own temporary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'viewer-diagnostic-'));
  try {
    const path = join(directory, 'receipt.json');
    const original = JSON.stringify({ status: 'refused', reason: 'readiness timeout' });
    writeFileSync(path, original);
    assert.throws(() => writeAtomicEvidence(path, '{"status":"complete"}', fd => {
      writeSync(fd, 'partial'); throw new Error('injected disk-full after actual partial write');
    }), /disk-full/);
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.deepEqual(readdirSync(directory), ['receipt.json']);
    writeAtomicEvidence(path, JSON.stringify({ status: 'refused', teardown: 'complete' }));
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).teardown, 'complete');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('#6537 diagnostic graph traversal distinguishes exact 200-node completion from exhausted limits', () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const chain = (count, link) => {
    let head = null;
    for (let index = 0; index < count; index++) head = { [link]: head };
    return head;
  };
  const canvas = { width: 1, height: 1, clientWidth: 1, clientHeight: 1, __reactFiber$fixture: null };
  // This fixture supplies the canvas graph; assertions exercise the actual bounded walk.
  Object.defineProperty(globalThis, 'document', { configurable: true,
    value: { visibilityState: 'visible', querySelector: () => canvas } });
  try {
    canvas.__reactFiber$fixture = chain(200, 'return');
    assert.deepEqual(refusedRendererSnapshot().traversal,
      { fiberCapExhausted: false, hookCapExhausted: false, visitedFibers: 200, complete: true });
    canvas.__reactFiber$fixture = chain(201, 'return');
    assert.equal(refusedRendererSnapshot().traversal.fiberCapExhausted, true);
    canvas.__reactFiber$fixture = { return: null, memoizedState: chain(200, 'next') };
    assert.equal(refusedRendererSnapshot().traversal.hookCapExhausted, false);
    canvas.__reactFiber$fixture.memoizedState = chain(201, 'next');
    const exhausted = refusedRendererSnapshot();
    assert.equal(exhausted.traversal.hookCapExhausted, true);
    assert.equal(exhausted.traversal.complete, false);
    assert.equal(exhausted.rendererFound, false);
  } finally {
    if (prior) Object.defineProperty(globalThis, 'document', prior);
    else delete globalThis.document;
  }
});
test('#6537 frozen refusal witness cannot absorb later teardown events or diagnostic mutation', () => {
  const row = { status: 'refused', reason: 'readiness timeout' };
  const events = [diagnosticEvent('console', 'stream complete', 'load-and-readiness', 0, 1)];
  const observed = { frame: null, queued: true };
  const snapshot = frozenBeforeTeardown(row, events, observed, 2);
  events.push(diagnosticEvent('console', 'Device lost', 'teardown', 0, 3));
  observed.queued = false;
  const saved = JSON.parse(snapshot.captured);
  assert.equal(saved.events.length, 1);
  assert.equal(saved.observed.queued, true);
  assert.equal(saved.status, 'refused');
  assert.equal(saved.reason, 'readiness timeout');
  assert.equal(snapshot.sha256, createHash('sha256').update(snapshot.captured).digest('hex'));
});
test('#6537 diagnostic rejection and hung observations terminate as unavailable', async () => {
  const failed = await boundedDiagnostic(Promise.reject(new Error('page closed')), 100);
  assert.equal(failed.status, 'unavailable'); assert.match(failed.reason, /page closed/);
  const hung = await boundedDiagnostic(new Promise(() => {}), 5);
  assert.equal(hung.status, 'unavailable'); assert.match(hung.reason, /deadline/);
});
