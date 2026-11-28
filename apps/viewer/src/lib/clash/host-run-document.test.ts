/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeExclusionSet, qualifiedKey, validateClashRunDocument, type Clash, type ClashResult, type ClashRunDocument } from '@ifc-lite/clash';
import type { ClashExclusionRule } from './exclusions.js';
import { Rule } from '@ifc-lite/rules';
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
const context: ClashRunHostContext = { models, presets: [], exclusions: new Set(), exclusionRules: [], tagInputs: null };

/** The document of a successful event; fails the test on an error event. */
function documentOf(event: ClashRunCompleteEvent | undefined): ClashRunDocument {
  assert.ok(event, 'an event was delivered');
  if (!event.ok) throw event.error;
  return event.document;
}

/** Collect the events of one registration while `run` publishes. */
async function collect(run: () => Promise<unknown>, options?: Parameters<typeof onClashRunComplete>[1]): Promise<ClashRunCompleteEvent[]> {
  const events: ClashRunCompleteEvent[] = [];
  const off = onClashRunComplete((event) => { events.push(event); }, options);
  try {
    await run();
  } finally {
    off();
  }
  return events;
}

describe('clash run host hook', () => {
  it('delivers nothing when no host registered', async () => {
    // No listener: nothing is loaded or built, and nothing throws.
    await notifyClashRunComplete(result, context);
  });

  it('builds off the publishing tick and delivers a valid, frozen browser-submitted document', async () => {
    const events: ClashRunCompleteEvent[] = [];
    const sha = 'd'.repeat(64);
    const off = onClashRunComplete((event) => { events.push(event); }, {
      resolveSlot: (model) => (model.id === 'm-arch' ? { slot: 'architecture', sha256: sha, label: 'ARC' } : null),
    });
    const first = notifyClashRunComplete(result, context);
    assert.equal(events.length, 0, 'nothing is built or delivered synchronously');
    off();
    await Promise.all([first, notifyClashRunComplete(result, context)]);
    assert.equal(events.length, 1, 'one run delivered, none after unsubscribe');
    const document = documentOf(events[0]);
    assert.deepEqual(document.labels, ['browser-submitted']);
    assert.deepEqual(document.manifest.slots, [
      { slot: 'architecture', sha256: sha, name: 'arch.ifc', label: 'ARC' },
      { slot: 'm-struct', sha256: null, name: 'struct.ifc' },
    ]);
    assert.equal(document.findings[0].a.slot, 'architecture');
    assert.equal(Object.isFrozen(document) && Object.isFrozen(document.findings[0].a), true, 'deeply frozen');
    assert.equal(validateClashRunDocument(JSON.parse(JSON.stringify(document))).ok, true, 'document validates');
  });

  it('resolves slots when the run publishes, not after the builder has loaded', async () => {
    let round = 'round-1';
    const events = await collect(async () => {
      const pending = notifyClashRunComplete(result, context);
      round = 'round-2'; // the host moves on while the builder chunk is still loading
      await pending;
    }, { resolveSlot: (model) => ({ slot: `${round}:${model.id}`, sha256: null }) });
    assert.deepEqual(documentOf(events[0]).manifest.slots.map((s) => s.slot), ['round-1:m-arch', 'round-1:m-struct']);
  });

  it('pins ruleRevisions at publish, so a later edit by the host does not relabel the run', async () => {
    const revisions: Record<string, string> = { r1: 'round-1-rules' };
    const events = await collect(async () => {
      const pending = notifyClashRunComplete(result, context);
      revisions.r1 = 'round-2-rules';
      await pending;
    }, { ruleRevisions: revisions });
    assert.equal(documentOf(events[0]).manifest.rules.items[0].revision, 'round-1-rules');
  });

  it('builds once per run and hands every listener with the same options the same object', async () => {
    const seen: ClashRunCompleteEvent[] = [];
    const offA = onClashRunComplete((event) => { seen.push(event); });
    const offB = onClashRunComplete((event) => { seen.push(event); });
    try {
      await notifyClashRunComplete(result, context);
    } finally {
      offA();
      offB();
    }
    assert.equal(seen.length, 2);
    assert.equal(documentOf(seen[0]) === documentOf(seen[1]), true, 'one shared document');
  });

  it('reports a document that cannot be built to the listener as an error result', async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      // Two loaded models put in one slot: the builder refuses.
      const events = await collect(() => notifyClashRunComplete(result, context), { resolveSlot: () => ({ slot: 'same', sha256: null }) });
      assert.equal(events.length, 1);
      const [event] = events;
      assert.equal(event.ok, false, 'an explicit failure, not silence');
      if (!event.ok) assert.match(event.error.message, /more than one model/);
    } finally {
      console.error = originalError;
    }
  });

  it('lists every gathered slot on a clean run and records the exclusions', async () => {
    const clean: ClashResult = { ...result, clashes: [] };
    rememberFederationIdentity(clean, new Map([['m-arch', 1], ['m-struct', 2]]));
    const [event] = await collect(() => notifyClashRunComplete(clean, { ...context,
      exclusions: makeExclusionSet([[qualifiedKey('m-arch', 'W'), qualifiedKey('m-struct', 'B')]]) }));
    const { manifest } = documentOf(event);
    assert.deepEqual(manifest.slots.map((s) => s.slot), ['m-arch', 'm-struct'], 'clean run still names its slots');
    assert.deepEqual(manifest.exclusions, [JSON.stringify([['m-arch', 'W'], ['m-struct', 'B']])]);
  });

  it("records the user's enabled exclusion rules and leaves their findings out", async () => {
    const rule = (enabled: boolean): ClashExclusionRule => ({ id: 'x', kind: 'typePair', a: 'IfcBeam', b: 'IfcWall',
      label: 'beams vs walls', enabled, createdAt: 0 });
    const [on] = await collect(() => notifyClashRunComplete(result, { ...context, exclusionRules: [rule(true)] }));
    assert.deepEqual(documentOf(on).findings, [], 'the excluded clash is not in the document');
    assert.deepEqual(documentOf(on).manifest.exclusionRules, [{ kind: 'typePair', a: 'IfcBeam', b: 'IfcWall' }]);
    const [off] = await collect(() => notifyClashRunComplete(result, { ...context, exclusionRules: [rule(false)] }));
    assert.equal(documentOf(off).findings.length, 1, 'a disabled rule suppresses nothing');
    assert.deepEqual(documentOf(off).manifest.exclusionRules, []);
  });

  it('pins an explicit-member rule to its saved filter, not its per-load members', async () => {
    const memberRule = { ...result.rulesRun[0], membersA: ['m-arch:10'] };
    const reload = { ...memberRule, membersA: ['m-arch:99'] };
    const preset = { id: 'r1', name: 'Walls vs beams', enabled: true,
      filterA: [{ combinator: 'AND' as const, rules: [Rule.modelTag('hasAny', ['tag-arch'])] }] };
    const edited = { ...preset, filterA: [{ combinator: 'AND' as const, rules: [Rule.modelTag('hasAny', ['tag-mep'])] }] };
    const events = await collect(async () => {
      await notifyClashRunComplete({ ...result, rulesRun: [memberRule] }, { ...context, presets: [preset] });
      await notifyClashRunComplete({ ...result, rulesRun: [reload] }, { ...context, presets: [preset] });
      await notifyClashRunComplete({ ...result, rulesRun: [reload] }, { ...context, presets: [edited] });
    });
    const revisions = events.map((event) => documentOf(event).manifest.rules.items[0].revision);
    assert.equal(revisions[0], revisions[1], 'a reload with new refs keeps the revision');
    assert.notEqual(revisions[1], revisions[2], 'an edited filter changes it');
  });

  it("ignores tag assignments that only another rule's filter names", async () => {
    const memberRule = { ...result.rulesRun[0], membersA: ['m-arch:10'] };
    const preset = { id: 'r1', filterA: [{ combinator: 'AND' as const, rules: [Rule.modelTag('hasAny', ['tag-arch'])] }] };
    const tags = (other: string[]) => new Map([['tag-arch', new Set(['m-arch'])], ['tag-other', new Set(other)]]);
    const events = await collect(async () => {
      await notifyClashRunComplete({ ...result, rulesRun: [memberRule] }, { ...context, presets: [preset], tagInputs: tags(['m-arch']) });
      await notifyClashRunComplete({ ...result, rulesRun: [memberRule] }, { ...context, presets: [preset], tagInputs: tags(['m-struct']) });
      await notifyClashRunComplete({ ...result, rulesRun: [memberRule] }, { ...context, presets: [preset],
        tagInputs: new Map([['tag-arch', new Set(['m-struct'])]]) });
    });
    const revisions = events.map((event) => documentOf(event).manifest.rules.items[0].revision);
    assert.equal(revisions[0], revisions[1], "another rule's tag does not move this revision");
    assert.notEqual(revisions[1], revisions[2], 'its own tag does');
  });

  it('logs an async listener rejection instead of leaving it unhandled', async () => {
    const originalError = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => { logged.push(args[1]); };
    const off = onClashRunComplete(async () => { throw new Error('store failed'); });
    try {
      await notifyClashRunComplete(result, context);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      off();
      console.error = originalError;
    }
    assert.equal(logged.length, 1, 'the rejection is logged once');
    assert.equal((logged[0] as Error).message, 'store failed');
  });

  it('keeps a failing listener from affecting another', async () => {
    const received: string[] = [];
    const originalError = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => { logged.push(args[0]); };
    const offBad = onClashRunComplete(() => { throw new Error('host failure'); });
    const offGood = onClashRunComplete((event) => { received.push(documentOf(event).findings[0].rule); });
    try {
      await notifyClashRunComplete(result, context);
    } finally {
      offBad();
      offGood();
      console.error = originalError;
    }
    assert.deepEqual(received, ['r1']);
    assert.equal(logged.length, 1, 'the failure is logged once');
  });
});
