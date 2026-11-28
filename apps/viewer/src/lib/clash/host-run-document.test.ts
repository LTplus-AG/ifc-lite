/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeExclusionSet, qualifiedKey, validateClashRunDocument, type Clash, type ClashResult } from '@ifc-lite/clash';
import { onClashRunComplete, type ClashRunCompleteEvent } from './host-run-listeners.js';
import { notifyClashRunComplete, type ClashRunHostContext } from './host-run-document.js';
import { rememberFederationIdentity } from './federation-identity.js';

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
const context: ClashRunHostContext = { models, presets: [], exclusions: new Set(), tagInputs: null };

describe('clash run host hook', () => {
  it('delivers nothing when no host registered', () => {
    // No listener: notify must be a no-op (and must not throw).
    notifyClashRunComplete(result, context);
  });

  it('delivers a valid browser-submitted run document with the host slots', () => {
    const events: ClashRunCompleteEvent[] = [];
    const sha = 'd'.repeat(64);
    const off = onClashRunComplete((event) => events.push(event), {
      resolveSlot: (model) => (model.id === 'm-arch' ? { slot: 'architecture', sha256: sha, label: 'ARC' } : null),
    });
    notifyClashRunComplete(result, context);
    off();
    notifyClashRunComplete(result, context);
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

  it('lists every gathered slot on a clean run and records the exclusions', () => {
    const clean: ClashResult = { ...result, clashes: [] };
    rememberFederationIdentity(clean, new Map([['m-arch', 1], ['m-struct', 2]]));
    const events: ClashRunCompleteEvent[] = [];
    const off = onClashRunComplete((event) => events.push(event));
    try {
      notifyClashRunComplete(clean, { ...context,
        exclusions: makeExclusionSet([[qualifiedKey('m-arch', 'W'), qualifiedKey('m-struct', 'B')]]) });
    } finally {
      off();
    }
    const { manifest } = events[0].document;
    assert.deepEqual(manifest.slots.map((s) => s.slot), ['m-arch', 'm-struct'], 'clean run still names its slots');
    assert.deepEqual(manifest.exclusions, [JSON.stringify([['m-arch', 'W'], ['m-struct', 'B']])]);
  });

  it('pins an explicit-member rule to its saved filter, not its per-load members', () => {
    const memberRule = { ...result.rulesRun[0], membersA: ['m-arch:10'] };
    const reload = { ...memberRule, membersA: ['m-arch:99'] };
    const preset = { id: 'r1', name: 'Walls vs beams', enabled: true, filterA: { storey: 'L1' } };
    const edited = { ...preset, filterA: { storey: 'L2' } };
    const revisions: string[] = [];
    const off = onClashRunComplete((event) => revisions.push(event.document.manifest.rules.items[0].revision));
    try {
      notifyClashRunComplete({ ...result, rulesRun: [memberRule] }, { ...context, presets: [preset] });
      notifyClashRunComplete({ ...result, rulesRun: [reload] }, { ...context, presets: [preset] });
      notifyClashRunComplete({ ...result, rulesRun: [reload] }, { ...context, presets: [edited] });
    } finally {
      off();
    }
    assert.equal(revisions[0], revisions[1], 'a reload with new refs keeps the revision');
    assert.notEqual(revisions[1], revisions[2], 'an edited filter changes it');
  });

  it('logs an async listener rejection instead of leaving it unhandled', async () => {
    const originalError = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => { logged.push(args[1]); };
    const off = onClashRunComplete(async () => { throw new Error('store failed'); });
    try {
      notifyClashRunComplete(result, context);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      off();
      console.error = originalError;
    }
    assert.equal(logged.length, 1, 'the rejection is logged once');
    assert.equal((logged[0] as Error).message, 'store failed');
  });

  it('keeps a failing listener from affecting another', () => {
    const received: string[] = [];
    const originalError = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => { logged.push(args[0]); };
    const offBad = onClashRunComplete(() => { throw new Error('host failure'); });
    const offGood = onClashRunComplete((event) => received.push(event.document.findings[0].rule));
    try {
      notifyClashRunComplete(result, context);
    } finally {
      offBad();
      offGood();
      console.error = originalError;
    }
    assert.deepEqual(received, ['r1']);
    assert.equal(logged.length, 1, 'the failure is logged once');
  });
});
