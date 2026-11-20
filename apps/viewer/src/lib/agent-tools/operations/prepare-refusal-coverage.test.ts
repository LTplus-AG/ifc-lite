/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { viewerOperations } from './registry';

/**
 * Every operation that may hand its caller a new token or id is classified (#10918). One that stores a candidate for
 * that token registers its removal (retainCandidate / c.retain), which the executor runs when the result is refused;
 * the refusal tests in stale-tokens.test.ts and graph-prepare-refusal.test.ts drive that through the real executor.
 * A new operation of this shape fails here until it is classified.
 */
const PREPARE_LIKE = /(\.prepare|\.capture|\.start|\.run|\.preview|\.plan|\.draft)$/;
const REFUSAL_TESTED: Record<string, string> = {
  'properties.prepare': 'stale-tokens: a refused properties prepare keeps no candidate',
  'authoring.prepare': 'same rememberAll store as properties.prepare',
  'validation.fix.prepare': 'same rememberAll store as properties.prepare',
  'changes.revert.prepare': 'stale-tokens: a refused revert prepare keeps no candidate',
  'ids.operations.prepare': 'stale-tokens: a refused IDS Studio prepare keeps no candidate',
  'ids.document.prepare': 'same remember store as ids.operations.prepare',
  'validation.ids.run': 'stale-tokens: a refused IDS validation run keeps no run handle',
  'validation.rules.run': 'same run store as validation.ids.run',
  'clash.reports.delete.prepare': 'stale-tokens: a refused clash report deletion prepare keeps no candidate',
  'zones.writeback.prepare': 'stale-tokens: a refused zone writeback prepare keeps no candidate',
  'authoring.group.prepare': 'graph-prepare-refusal: refused, background, collected, evicted',
  'authoring.structural.prepare': 'same graph store as authoring.group.prepare',
  'authoring.zone.prepare': 'same graph store as authoring.group.prepare',
  'authoring.room.prepare': 'same graph store as authoring.group.prepare',
};
/** Stores a candidate and registers its removal; an executor refusal test needs its own domain fixture (follow-up). */
const RETAINED_UNTESTED: Record<string, string> = {
  'storeys.prepare': 'retainCandidate in authoring-storeys.ts',
  'clash.classification.prepare': 'retainCandidate in clash-native-classification.ts',
  'appearance.capture.prepare': 'retainCandidate in appearance-native-capture.ts',
  'appearance.scan.prepare': 'retainCandidate in appearance-native-scan.ts',
};
/** Hands out no new stored token, or stores it inside a committed write (the executor keeps committed effects). */
const NO_UNDELIVERED_CANDIDATE: Record<string, string> = {
  'appearance.preview': 'stores its candidate inside c.commit, with the committed scene preview',
  'appearance.references.prepare': 'stores its candidate inside c.commit, with the committed scene preview',
  'appearance.faces.prepare': 'goes through the appearance.preview candidate, inside c.commit',
  'appearance.plan': 'reads a plan; stores nothing for the caller',
  'appearance.scan.transfer.prepare': 'updates an existing scan session the caller already holds',
  'clash.classification.run': 'runs a classification; its review token comes from clash.classification.prepare',
  'clash.classification.plan': 'reads a plan; stores nothing for the caller',
  'clash.run': 'runs into the viewer clash state, not a host candidate store',
  'filters.run': 'reads; stores nothing for the caller',
  'lists.run': 'reads; stores nothing for the caller',
  'presentation.capture': 'captures a view; stores nothing for the caller',
  'placement.translation.preview': 'computes a preview; stores nothing for the caller',
  'exports.anonymized.prepare': 'returns the plan inline; stores nothing for the caller',
};

describe('operations that hand out a token are classified for refusal (#10918)', () => {
  const ids = viewerOperations().map(entry => entry.id);
  it('every prepare-like operation is in exactly one class', () => {
    const classes = [REFUSAL_TESTED, RETAINED_UNTESTED, NO_UNDELIVERED_CANDIDATE];
    const unclassified = ids.filter(id => PREPARE_LIKE.test(id) && !classes.some(map => id in map));
    const twice = ids.filter(id => classes.filter(map => id in map).length > 1);
    assert.deepEqual({ unclassified, twice }, { unclassified: [], twice: [] });
  });
  it('every classified id is a registered operation', () => {
    const registered = new Set(ids);
    const stale = [REFUSAL_TESTED, RETAINED_UNTESTED, NO_UNDELIVERED_CANDIDATE].flatMap(Object.keys).filter(id => !registered.has(id));
    assert.deepEqual(stale, []);
  });
});
