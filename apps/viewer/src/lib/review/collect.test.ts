/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotFrom } from './collect';
import { element, fakeModel, finding, run } from './test-support';
import type { FindingSource } from './types';

const models = [fakeModel('m1', 'arch.ifc', ['W1'])];
const ok = (kind: FindingSource['kind'], globalId: string): FindingSource => ({ kind, collect: () => ({
  runs: [run(`${kind}:current`, kind)], findings: [finding(globalId, kind, [element(globalId, 'arch.ifc', 'm1')])] }) });

test('a throwing source is reported as failed, never as an empty clean source, and the others still contribute', () => {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const snapshot = snapshotFrom([ok('clash', 'W1'), { kind: 'validation', collect: () => { throw new Error('boom'); } }, ok('linked', 'W1')], models);
    assert.deepEqual(snapshot.failed, [{ source: 'validation', message: 'boom' }]);
    assert.equal(snapshot.findings.length, 2);
    assert.equal(snapshot.cards.length, 1, 'clash and linked finding on the same element share one card');
  } finally { console.warn = warn; }
});

test('no sources and no models produce an empty snapshot', () => {
  const snapshot = snapshotFrom([], []);
  assert.deepEqual([snapshot.cards, snapshot.runs, snapshot.failed], [[], [], []]);
  assert.equal(snapshot.totals.cards, 0);
});
