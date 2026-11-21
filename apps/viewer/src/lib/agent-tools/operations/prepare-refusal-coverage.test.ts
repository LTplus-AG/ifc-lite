/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { viewerOperations } from './registry';

/**
 * Every operation that may hand its caller a new token or id is classified (#10918). One that stores a candidate for
 * that token registers its removal (retainCandidate / c.retain), which the executor runs when the result is refused;
 * the refusal tests drive that through the real executor.
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
  'storeys.prepare': 'domain-prepare-refusal: a refused storey candidate cannot apply',
  'clash.classification.prepare': 'domain-prepare-refusal: a refused classification review cannot be sampled',
  'appearance.capture.prepare': 'domain-prepare-refusal: a refused capture candidate is unknown',
  'appearance.scan.prepare': 'domain-prepare-refusal: a refused scan session cannot be inspected',
};
/** Hands out no new stored token, or stores it inside a committed write (the executor keeps committed effects). */
const NO_UNDELIVERED_CANDIDATE: Record<string, string> = {
  'document.prepareReportRefresh': 'stores the refresh candidate inside c.commit',
  'assistant.prepareReportDraft': 'stores the draft candidate inside c.commit',
  'assistant.reviseReportDraftClaim': 'updates a draft token the caller already holds, inside c.commit',
  'compare.run': 'publishes the result into viewer state inside c.commit',
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

/** An output schema that hands the caller a token or run id, at any depth. */
const handsOutToken = (schema: unknown): boolean => {
  if (!schema || typeof schema !== 'object') return false;
  const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  return 'token' in properties || 'run_id' in properties || Object.values(schema).some(handsOutToken);
};

describe('operations that hand out a token are classified for refusal (#10918)', () => {
  const operations = viewerOperations(), ids = operations.map(entry => entry.id);
  it('every prepare-like operation, or one whose result carries a token, is in exactly one class', () => {
    const classes = [REFUSAL_TESTED, NO_UNDELIVERED_CANDIDATE];
    const unclassified = operations.filter(entry => (PREPARE_LIKE.test(entry.id) || handsOutToken(entry.outputSchema)) && !classes.some(map => entry.id in map))
      .map(entry => entry.id);
    const twice = ids.filter(id => classes.filter(map => id in map).length > 1);
    assert.deepEqual({ unclassified, twice }, { unclassified: [], twice: [] });
  });
  it('every classified id is a registered operation', () => {
    const registered = new Set(ids);
    const stale = [REFUSAL_TESTED, NO_UNDELIVERED_CANDIDATE].flatMap(Object.keys).filter(id => !registered.has(id));
    assert.deepEqual(stale, []);
  });
});
