/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateClashRunDocument, type Clash, type ClashResult } from '@ifc-lite/clash';
import { onClashRunComplete, type ClashRunCompleteEvent } from './host-run-listeners.js';
import { notifyClashRunComplete } from './host-run-document.js';

const clash: Clash = {
  id: 'r1:m-arch:m-struct',
  a: { key: '0K7w7JN4X3Ae9wq8z_zF2v', ref: 10, model: 'm-arch', tag: 'IfcWall' },
  b: { key: '1hOSvn6df7F8_7GcBWlRGQ', ref: 20, model: 'm-struct', tag: 'IfcBeam' },
  rule: 'r1', status: 'hard', distance: -0.02, distanceKind: 'estimate',
  point: [0, 0, 0], bounds: { min: [0, 0, 0], max: [1, 1, 1] }, severity: 'major',
};
const result: ClashResult = {
  clashes: [clash],
  summary: { total: 1, byRule: {}, byTypePair: {}, bySeverity: { critical: 0, major: 1, minor: 0, info: 0 } },
  rulesRun: [{ id: 'r1', name: 'Walls vs beams', a: 'IfcWall*', b: 'IfcBeam*', mode: 'hard' }],
  settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
};
const models = new Map([['m-arch', { id: 'm-arch', name: 'arch.ifc' }], ['m-struct', { id: 'm-struct', name: 'struct.ifc' }]]);

describe('clash run host hook', () => {
  it('delivers nothing when no host registered', () => {
    // No listener: notify must be a no-op (and must not throw).
    notifyClashRunComplete(result, models);
  });

  it('delivers a valid browser-submitted run document with the host slots', () => {
    const events: ClashRunCompleteEvent[] = [];
    const sha = 'd'.repeat(64);
    const off = onClashRunComplete((event) => events.push(event), {
      resolveSlot: (model) => (model.id === 'm-arch' ? { slot: 'architecture', sha256: sha, label: 'ARC' } : null),
    });
    notifyClashRunComplete(result, models);
    off();
    notifyClashRunComplete(result, models);
    assert.equal(events.length, 1, 'one run delivered, none after unsubscribe');
    const { document } = events[0];
    assert.deepEqual(document.labels, ['browser-submitted']);
    assert.deepEqual(document.manifest.slots, [
      { slot: 'architecture', sha256: sha, name: 'arch.ifc', label: 'ARC' },
      { slot: 'm-struct', sha256: null, name: 'struct.ifc' },
    ]);
    assert.equal(document.findings[0].a.slot, 'architecture');
    assert.equal(validateClashRunDocument(JSON.parse(JSON.stringify(document))).ok, true, 'document validates');
  });

  it('keeps a failing listener from affecting another', () => {
    const received: string[] = [];
    const originalError = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => { logged.push(args[0]); };
    const offBad = onClashRunComplete(() => { throw new Error('host failure'); });
    const offGood = onClashRunComplete((event) => received.push(event.document.findings[0].rule));
    try {
      notifyClashRunComplete(result, models);
    } finally {
      offBad();
      offGood();
      console.error = originalError;
    }
    assert.deepEqual(received, ['r1']);
    assert.equal(logged.length, 1, 'the failure is logged once');
  });
});
