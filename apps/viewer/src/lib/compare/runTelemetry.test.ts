/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Compare telemetry payloads (#1891 rollout evidence, #4955 claim
 * counts). The counts are what the field decides on, so a stage that ran
 * and found nothing, a stage that abstained, and a stage that found N must
 * read 0 / 0 / N — and the export event must count the same things the run
 * event does.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelDiff } from '@ifc-lite/diff';
import type { CompareRef } from './buildFingerprints.js';
import type { CompareResult } from '../../store/slices/compareSlice.js';
import { claimDecisionPayload, compareExportPayload, compareRunPayload } from './runTelemetry.js';

const fp = (key: string) => ({ key, ifcType: 'IfcWall', dataHash: 'd', ref: { modelId: 'B', localId: 1, globalId: 1 } });

function result(diff: Partial<ModelDiff<CompareRef>>): CompareResult {
  return {
    baseModelId: 'A',
    headModelId: 'B',
    baseName: 'A',
    headName: 'B',
    scope: 'both',
    geometryUnavailable: false,
    excludedHiddenIds: new Set(),
    diff: {
      entries: [],
      byKey: new Map(),
      counts: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
      scope: 'both',
      excludedTypes: [],
      ...diff,
    },
  };
}

describe('compareRunPayload / compareExportPayload (#4955)', () => {
  it('counts respecified matches, successor claims, split/merge claims and applied aliases', () => {
    const r = result({
      contentMatches: [
        { kind: 'respecified', dataHash: 'd', base: [fp('a')], head: [fp('b')] },
        { kind: 'renamed', dataHash: 'd', base: [fp('c')], head: [fp('d')] },
      ],
      successors: [{ confidence: 'footprint', base: fp('e'), head: fp('f'), overlap: 0.9, distance: 0 }],
      splitMerges: [
        { kind: 'split', confidence: 'extent', whole: fp('g'), pieces: [fp('h'), fp('i')] },
        { kind: 'merge', confidence: 'extent', whole: fp('j'), pieces: [fp('k'), fp('l')] },
      ],
      appliedKeyAliases: new Map([['n', 'm']]),
    });
    const run = compareRunPayload(r, true);
    assert.equal(run.content_match_respecified, 1);
    assert.equal(run.content_match_renamed, 1);
    assert.equal(run.successor_claims, 1);
    assert.equal(run.split_merge_claims, 2);
    assert.equal(run.accepted_identity_count, 1);
    const exported = compareExportPayload('identity-map', r);
    assert.equal(exported.format, 'identity-map');
    assert.equal(exported.content_match_respecified, 1);
    assert.equal(exported.successor_claims, 1);
    assert.equal(exported.split_merge_claims, 2);
  });

  it('reads 0 for a stage that abstained (no geometry) and for one that found nothing', () => {
    const abstained = compareRunPayload(result({ contentMatches: undefined }), false);
    assert.equal(abstained.successor_claims, 0);
    assert.equal(abstained.split_merge_claims, 0);
    assert.equal(abstained.content_match_respecified, 0);
    const empty = compareRunPayload(result({ successors: [], splitMerges: [], contentMatches: [] }), true);
    assert.equal(empty.successor_claims, 0);
    assert.equal(empty.split_merge_claims, 0);
  });
});

describe('claimDecisionPayload', () => {
  it('carries the confidence for a successor and omits it for an ambiguous pair', () => {
    assert.deepEqual(claimDecisionPayload('successor', 'successor:position', 'position'), {
      kind: 'successor',
      confidence: 'position',
      reason: 'successor:position',
    });
    assert.deepEqual(claimDecisionPayload('ambiguous', 'accepted:ambiguous'), {
      kind: 'ambiguous',
      reason: 'accepted:ambiguous',
    });
  });
});
