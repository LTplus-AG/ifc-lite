/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `estimateIdsBcfTopicCount` must count exactly what the real reporter
 * emits, for every grouping, or the dialog's number and cap warning lie
 * (#5824). Each case below runs `createBCFFromIDSReport` itself with the cap
 * out of the way and compares topic counts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBCFFromIDSReport, type IDSEntityResultInput, type IDSReportInput, type IDSSpecResultInput } from '@ifc-lite/bcf';
import { estimateIdsBcfTopicCount, IDS_BCF_MAX_TOPICS, idsBcfSnapshotTargets, type IdsBcfTopicGrouping } from './bcf-topic-estimate.js';

function entity(expressId: number, modelId: string, failingReqs: number, passingReqs = 1): IDSEntityResultInput {
  const req = (status: 'pass' | 'fail', i: number) => ({ status, facetType: 'property', checkedDescription: `req ${i}` });
  return {
    expressId, modelId, entityType: 'IfcWall', entityName: `Wall ${expressId}`, globalId: `guid-${modelId}-${expressId}`,
    passed: failingReqs === 0,
    requirementResults: [
      ...Array.from({ length: failingReqs }, (_, i) => req('fail', i)),
      ...Array.from({ length: passingReqs }, (_, i) => req('pass', failingReqs + i)),
    ],
  };
}

function spec(name: string, status: IDSSpecResultInput['status'], entityResults: IDSEntityResultInput[]): IDSSpecResultInput {
  const failed = entityResults.filter((e) => !e.passed).length;
  return {
    specification: { name }, status, entityResults,
    applicableCount: entityResults.length, passedCount: entityResults.length - failed, failedCount: failed,
    ...(status === 'fail' && entityResults.length === 0
      ? { cardinalityResult: { passed: false, actualCount: 0, minExpected: 1, message: 'required' } }
      : {}),
  };
}

/** Failing, passing, cardinality-only and not-applicable specs, across two models (N models). */
const REPORT: IDSReportInput = {
  title: 'Fixture',
  specificationResults: [
    spec('Walls need fire rating', 'fail', [entity(1, 'A', 2), entity(2, 'A', 1), entity(3, 'A', 0), entity(1, 'B', 3)]),
    spec('Slabs need names', 'pass', [entity(10, 'A', 0), entity(11, 'B', 0)]),
    // The same wall (A:1) failing a SECOND specification: the reporter emits
    // one per-entity topic per (specification, entity), with no dedup, while
    // snapshots are shared (one image per entity).
    spec('Walls need names', 'fail', [entity(1, 'A', 1)]),
    spec('Model has a site', 'fail', []),
    spec('Doors need width', 'not_applicable', []),
  ],
};

const GROUPINGS: IdsBcfTopicGrouping[] = ['per-entity', 'per-specification', 'per-requirement'];

function reporterTopicCount(report: IDSReportInput, topicGrouping: IdsBcfTopicGrouping, includePassingEntities: boolean): number {
  return createBCFFromIDSReport(report, { topicGrouping, includePassingEntities, maxTopics: 1_000_000 }).topics.size;
}

describe('estimateIdsBcfTopicCount (#5824)', () => {
  for (const topicGrouping of GROUPINGS) {
    for (const includePassingEntities of [false, true]) {
      it(`matches the reporter for ${topicGrouping}${includePassingEntities ? ' with passing entities' : ''}`, () => {
        assert.equal(
          estimateIdsBcfTopicCount(REPORT, { topicGrouping, includePassingEntities }),
          reporterTopicCount(REPORT, topicGrouping, includePassingEntities),
        );
      });
    }
  }

  it('counts an entity failing two specifications twice, like the reporter (one topic per spec and entity)', () => {
    // 3 failing entities in spec 1, A:1 again in "Walls need names", 1 cardinality topic.
    assert.equal(estimateIdsBcfTopicCount(REPORT, { topicGrouping: 'per-entity', includePassingEntities: false }), 5);
    assert.equal(reporterTopicCount(REPORT, 'per-entity', false), 5);
  });

  it('shows why per-entity is the wrong default: it scales with the model, per-specification does not', () => {
    const big: IDSReportInput = {
      title: 'Big',
      specificationResults: [spec('Walls need fire rating', 'fail', Array.from({ length: 5000 }, (_, i) => entity(i + 1, 'A', 1)))],
    };
    assert.equal(estimateIdsBcfTopicCount(big, { topicGrouping: 'per-entity', includePassingEntities: false }), 5000);
    assert.equal(estimateIdsBcfTopicCount(big, { topicGrouping: 'per-specification', includePassingEntities: false }), 1);
  });

  it('caps snapshot targets at the topic cap, dedups across specs and keeps model identity (N models)', () => {
    const big: IDSReportInput = {
      title: 'Big',
      specificationResults: [
        spec('A', 'fail', Array.from({ length: 3000 }, (_, i) => entity(i + 1, i % 2 === 0 ? 'A' : 'B', 1))),
        spec('B', 'fail', [entity(1, 'A', 1)]),
      ],
    };
    const targets = idsBcfSnapshotTargets(big, false);
    assert.equal(targets.length, IDS_BCF_MAX_TOPICS);
    assert.equal(new Set(targets.map((t) => t.boundsKey)).size, targets.length);
    assert.deepEqual(targets.slice(0, 2).map((t) => t.boundsKey), ['A:1', 'B:2']);
    // Same model-A entity in two specs is one snapshot; passing ones only on request.
    assert.deepEqual(idsBcfSnapshotTargets(REPORT, false).map((t) => t.boundsKey), ['A:1', 'A:2', 'B:1']);
    assert.equal(idsBcfSnapshotTargets(REPORT, true).length, 6);
  });
});
