/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS, validateIDS, type ValidationReport } from '@ifc-lite/ids';
import { createDataAccessor } from '@ifc-lite/ids/bridge';
import { validationFindings } from './validation';
import type { ReviewModel } from '../types';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function nativeSource() {
  const samples = new URL('../../../../public/samples/', import.meta.url);
  const bytes = new Uint8Array(readFileSync(new URL('building-architecture.ifc', samples)));
  const store = await new IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
  assert.ok(store.schemaVersion);
  const document = parseIDS(readFileSync(new URL('building-architecture.ids', samples), 'utf8'));
  const modelId = 'native-architecture';
  const info = { modelId, schemaVersion: store.schemaVersion, entityCount: store.entityCount };
  const model: ReviewModel = { id: modelId, name: 'building-architecture.ifc',
    expressIdOf: guid => store.entities.getExpressIdByGlobalId(guid),
    globalIdOf: id => store.entities.getGlobalId(id) ?? '' };
  return { bytes, store, document, modelId, info, model };
}
const nativeFacts = (report: ValidationReport) => report.specificationResults.map(spec => spec.entityResults.map(row => ({
  modelId: row.modelId, expressId: row.expressId, globalId: row.globalId, passed: row.passed,
  requirements: row.requirementResults.map(requirement => ({ status: requirement.status,
    checkedDescription: requirement.checkedDescription, failureReason: requirement.failureReason })) })));

// Stable original viewer APIs observe the canonical shared implementation and its inverse.
test('#7372 actual native capped IDS evaluation retains incomplete coverage and exact evaluated facts', async () => {
  const x = await nativeSource();
  const capped = await validateIDS(x.document, createDataAccessor(x.store), x.info,
    { maxEntities: 1, includePassingEntities: true });
  const partial = capped.specificationResults.filter(spec => spec.passedCount + spec.failedCount < spec.applicableCount);
  assert.ok(partial.length > 0, 'actual native cap leaves applicable source elements unevaluated');
  assert.ok(capped.specificationResults.every(spec => !spec.error && !spec.setResultsTruncated));
  const before = nativeFacts(capped);
  const review = validationFindings({ report: capped, stale: false }, [x.model]);
  assert.equal(review.findings.length,
    capped.specificationResults.flatMap(spec => spec.entityResults.filter(entity => !entity.passed)).length,
    'only real evaluated native failure rows are published');
  assert.ok(review.findings.every(finding => finding.elements.every(element => element.modelId === x.modelId)));
  assert.deepEqual(nativeFacts(capped), before, 'normalization preserves original native requirement facts');
  assert.equal(digest(x.store.source.materialize()), digest(x.bytes), 'read-only normalization leaves source bytes untouched');
  console.info('[7372-native-coverage-prerequisites]', JSON.stringify({ partialSpecifications: partial.length,
    applicable: partial.map(spec => spec.applicableCount), evaluated: partial.map(spec => spec.passedCount + spec.failedCount),
    nativeFailureRows: review.findings.length, reportedComplete: review.runs[0]?.complete }));
  assert.equal(review.runs[0]?.complete, false, 'native evaluation omission cannot confirm absence or resolution');
  assert.equal(review.runs[0]?.incomplete.filter(gap => gap.code === 'truncated').length, partial.length);
});

test('#7372 actual full native IDS evaluation stays complete when passing detail rows are omitted', async () => {
  const x = await nativeSource();
  const filtered = await validateIDS(x.document, createDataAccessor(x.store), x.info, { includePassingEntities: false });
  assert.ok(filtered.specificationResults.every(spec => spec.passedCount + spec.failedCount === spec.applicableCount),
    'native full run records evaluated passing counts even when passing detail rows are omitted');
  assert.ok(filtered.specificationResults.some(spec => spec.entityResults.length < spec.applicableCount),
    'real source distinguishes passing-detail omission from an evaluation cap');
  assert.equal(validationFindings({ report: filtered, stale: false }, [x.model]).runs[0]?.complete, true,
    'fully evaluated native scope stays complete when only passing detail rows are hidden');
  assert.equal(digest(x.store.source.materialize()), digest(x.bytes));
});
