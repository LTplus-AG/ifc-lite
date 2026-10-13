/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { IfcParser } from '@ifc-lite/parser';
import { Rule, type RuleSetFile } from '@ifc-lite/rules';
import { clashReviewKey, type ClashRule } from '@ifc-lite/clash';
import { NativeReviewCaptures, createNativeReviewIdentityTable, readPortableReview,
  decodeSavedAnalysisRun, type NativeReviewModel, type SavedAnalysisRun } from '@ifc-lite/sdk/review';
import type { ViewerState } from '@/store';
import { analysisStampFrom } from '@/hooks/useAnalysisStaleness';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { portableAnalysisRun } from '@/lib/compare/saved-analysis-run-binding';
import { revisionPair, runClash, PINS, type LoadedModel } from '@/lib/compare/revision-pair.test-support';
import { runInformationCheck } from '@/lib/validation/run-information-check';

type State = Pick<ViewerState, 'models' | 'mutationVersion' | 'geometryContentVersion' | 'modelPlacement' | 'hasChanges'>;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function state(models: readonly LoadedModel[]): State {
  return { models: new Map(models.map(model => [model.id, { ...model,
    sourceContentHash: hash(model.ifcDataStore.source.materialize()), sourceFingerprint: undefined }])),
    mutationVersion: 0, geometryContentVersion: 0, modelPlacement: emptyPlacementState(), hasChanges: () => false };
}
async function reload(models: readonly LoadedModel[]): Promise<NativeReviewModel[]> {
  return Promise.all(models.map(async model => {
    const bytes = model.ifcDataStore.source.materialize();
    const store = await new IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
    return { id: `reloaded-${model.id}`, name: 'same-renamed-filename.ifc', owner: store, store, source: store.source,
      mutationView: () => null, identityTable: createNativeReviewIdentityTable(store),
      expressIdOf: GlobalId => store.entities.getExpressIdByGlobalId(GlobalId),
      globalIdOf: expressId => store.entities.getGlobalId(expressId) ?? '' };
  }));
}
function decoded(saved: SavedAnalysisRun): SavedAnalysisRun {
  const result = decodeSavedAnalysisRun(JSON.parse(JSON.stringify(saved)));
  assert.ok(result, 'the actual save adapter must produce a canonical portable wire');
  return result;
}
function meshDigest(meshes: readonly { positions: Float32Array; normals: Float32Array; indices: Uint32Array }[]): string {
  const digest = createHash('sha256');
  for (const mesh of meshes) for (const values of [mesh.positions, mesh.normals, mesh.indices]) {
    digest.update(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
  }
  return digest.digest('hex');
}

const clashRules: ClashRule[] = [{ id: 'actual-duct-wall', name: 'Native duct versus wall', a: 'IfcDuctSegment', b: 'IfcWall', mode: 'hard' }];
for (const count of [1, 2]) {
  test(`#7372 real revision clash wire preserves native occurrences and coverage after ${count}-model reload`, async t => {
    const pair = await revisionPair(t); if (!pair) return;
    const models = count === 1 ? [pair.head] : [pair.base, pair.head];
    const ids = models.map(model => model.id);
    const originalState = state(models), stamp = analysisStampFrom(originalState, true);
    const sourceHashes = models.map(model => hash(model.ifcDataStore.source.materialize()));
    const meshes = ids.flatMap(id => pair.meshes.get(id) ?? []), originalMeshes = meshDigest(meshes);
    const native = await runClash(pair, ids, { rules: clashRules });
    assert.ok(native.clashes.length > 0, 'the committed derived revision introduces a real duct/wall intersection');
    assert.ok(native.clashes.some(clash => [clash.a.key, clash.b.key].some(key => key === PINS.clashAdded || key.startsWith(`${PINS.clashAdded}:`))));
    assert.ok(native.ruleCoverage?.length);
    assert.equal(native.truncated, undefined);
    const portable = portableAnalysisRun({ id: `actual-clash-${count}`, kind: 'clash', result: native,
      modelIds: ids, capturedAt: new Date().toISOString(), stamp }, originalState);
    assert.ok(portable.ok, portable.ok ? '' : portable.reason);
    const saved = decoded(portable.saved);
    assert.equal(saved.kind, 'clash'); if (saved.kind !== 'clash') throw new Error('Actual clash wire required');
    const wireBefore = JSON.stringify(saved), nativeBefore = JSON.stringify(native);
    const live = await reload(models);
    const result = await readPortableReview(new NativeReviewCaptures(), () => live,
      { savedAnalysisRuns: [saved], maxFindings: 512 }, () => true);
    assert.equal(result.origin, 'imported'); assert.deepEqual(result.provenance, []);
    assert.equal(result.sources.find(source => source.source === 'clash')?.state, 'available');
    assert.equal(result.sources.find(source => source.source === 'validation')?.state, 'not-run');
    assert.equal(result.bindings[0]?.state, 'bound');
    assert.equal(result.findings.length, native.clashes.length);
    assert.ok(result.findings.every(finding => finding.lifecycle === 'not-evaluated' && finding.run.temporal === 'historical' && !finding.run.complete));
    assert.equal(result.bounds.nativeCoverageComplete, false);
    assert.deepEqual(result.findings.map(finding => finding.nativeStatus), native.clashes.map(clash => clash.status));
    assert.deepEqual(result.findings.map(finding => finding.evidence.kind === 'clash-baseline' ? finding.evidence.reviewKey : null), native.clashes.map(clashReviewKey));
    const recorded = result.records[0]?.value;
    assert.ok(recorded && 'kind' in recorded && recorded.kind === 'clash');
    if (!recorded || !('kind' in recorded) || recorded.kind !== 'clash') throw new Error('Original native clash record missing');
    assert.deepEqual(recorded.result, saved.result, 'native occurrence keys, rule coverage, settings, distance and summary remain exact');
    assert.ok(result.cards.every(card => card.identity === 'validated' && card.state === 'not-evaluated'));
    const ruleSet: RuleSetFile = { version: 1, name: 'Actual mixed-library identity check', rules: [{
      id: 'mixed-native-identity', name: 'Recorded subject identity',
      applicability: { groups: [{ rules: [Rule.globalId([PINS.dataModified])], combinator: 'AND' }], authoredAs: 'chips' },
      requirement: { kind: 'element', block: { groups: [{ rules: [Rule.attribute('GlobalId', 'eq', '0'.repeat(22))], combinator: 'AND' }], authoredAs: 'chips' } },
    }] };
    const { report } = await runInformationCheck({ ruleSet,
      models: models.map(model => ({ id: model.id, store: model.ifcDataStore })), reportModels: originalState.models });
    assert.ok(report.specificationResults.every(spec => !spec.error));
    assert.equal(report.specificationResults[0].failedCount, count);
    const validation = portableAnalysisRun({ id: `mixed-information-${count}`, kind: 'validation', report,
      modelIds: ids, capturedAt: report.timestamp.toISOString(), stamp: analysisStampFrom(originalState, false) }, originalState);
    assert.ok(validation.ok, validation.ok ? '' : validation.reason);
    const validationWire = decoded(validation.saved);
    const mixed = await readPortableReview(new NativeReviewCaptures(), () => live,
      { savedAnalysisRuns: [saved, validationWire], maxFindings: 512 }, () => true);
    assert.equal(mixed.sources.find(source => source.source === 'clash')?.state, 'available');
    assert.equal(mixed.sources.find(source => source.source === 'validation')?.state, 'available');
    assert.equal(mixed.findings.length, native.clashes.length + count);
    assert.equal(mixed.bounds.knownFindings, mixed.findings.length);
    assert.equal(mixed.bounds.knownFindingsScope, 'supplied-historical-records');
    assert.equal(mixed.bounds.nativeCoverageComplete, false);
    assert.equal(JSON.stringify(saved), wireBefore); assert.equal(JSON.stringify(native), nativeBefore);
    assert.equal(meshDigest(meshes), originalMeshes, 'actual producer meshes are not rewritten by save/import/projection');
    assert.deepEqual(models.map(model => hash(model.ifcDataStore.source.materialize())), sourceHashes);
    assert.deepEqual(live.map(model => hash(model.source.materialize())), sourceHashes);
    console.info('7372-real-clash-portable-prerequisites', JSON.stringify({ models: count, nativeClashes: native.clashes.length,
      occurrenceKeys: native.clashes.map(clash => [clash.a.key, clash.b.key]), bound: true, historical: true }));
  });

  test(`#7372 actual information-rule producer retains rule content and native failure facts after ${count}-model reload`, async t => {
    const pair = await revisionPair(t); if (!pair) return;
    const models = count === 1 ? [pair.head] : [pair.base, pair.head];
    const ids = models.map(model => model.id), originalState = state(models);
    // Capture full original source identities before evaluation, rather than
    // looking up a possibly replaced model when the report is later saved.
    const stamp = analysisStampFrom(originalState, true);
    // Authentic same subject in each committed revision; a different required
    // GlobalId is a stated invariant evaluated by the actual native rule engine.
    const demanded = '0000000000000000000000'; assert.notEqual(PINS.dataModified, demanded);
    const ruleSet: RuleSetFile = { version: 1, name: 'Portable native identity invariant', rules: [{
      id: 'native-identity', name: 'Native subject must have demanded identity',
      applicability: { groups: [{ rules: [Rule.globalId([PINS.dataModified])], combinator: 'AND' }], authoredAs: 'chips' },
      requirement: { kind: 'element', block: { groups: [{ rules: [Rule.attribute('GlobalId', 'eq', demanded)], combinator: 'AND' }], authoredAs: 'chips' } },
    }] };
    const sourceHashes = models.map(model => hash(model.ifcDataStore.source.materialize()));
    const { report } = await runInformationCheck({ ruleSet, models: models.map(model => ({ id: model.id, store: model.ifcDataStore })),
      reportModels: originalState.models });
    assert.equal(report.source.kind, 'rules');
    assert.deepEqual(report.modelInfo.map(model => model.modelId).sort(), [...ids].sort());
    assert.equal(report.specificationResults.length, 1);
    const spec = report.specificationResults[0];
    assert.ok(!spec.error); assert.notEqual(spec.setResultsTruncated, true);
    assert.equal(spec.applicableCount, count); assert.equal(spec.entityResults.length, count);
    assert.ok(spec.entityResults.every(row => !row.passed && row.globalId === PINS.dataModified));
    assert.deepEqual(spec.entityResults.map(row => row.modelId).sort(), [...ids].sort());
    const portable = portableAnalysisRun({ id: `actual-information-${count}`, kind: 'validation', report,
      modelIds: ids, capturedAt: report.timestamp.toISOString(), stamp }, originalState);
    assert.ok(portable.ok, portable.ok ? '' : portable.reason);
    const saved = decoded(portable.saved);
    assert.equal(saved.kind, 'validation'); if (saved.kind !== 'validation') throw new Error('Actual rule report wire required');
    assert.equal(saved.ruleSet?.file, JSON.stringify(ruleSet));
    assert.deepEqual(saved.ruleSet?.rules, ruleSet.rules.map(rule => [rule.id, JSON.stringify(rule)]));
    const wireBefore = JSON.stringify(saved), reportBefore = JSON.stringify(report), live = await reload(models);
    const result = await readPortableReview(new NativeReviewCaptures(), () => live,
      { sources: ['validation'], savedAnalysisRuns: [saved], maxFindings: 512 }, () => true);
    assert.equal(result.bindings[0]?.state, 'bound'); assert.equal(result.origin, 'imported');
    assert.deepEqual(result.provenance, []); assert.equal(result.bounds.nativeCoverageComplete, false);
    assert.equal(result.findings.length, spec.failedCount);
    assert.ok(result.findings.every(finding => finding.nativeStatus === 'failed' && finding.lifecycle === 'not-evaluated'
      && finding.run.temporal === 'historical' && !finding.run.complete));
    assert.deepEqual(result.findings.flatMap(finding => finding.elements.map(element => element.globalId)), spec.entityResults.map(row => row.globalId));
    assert.deepEqual(result.records[0]?.value, saved, 'native rules, requirements, values, counts, sets and original provenance survive intact');
    const resolved = result.cards.flatMap(card => card.elements.map(element => element.resolvedModelId));
    assert.deepEqual([...new Set(resolved)].sort(), live.map(model => model.id).sort());
    assert.equal(result.totals.uniqueElements, count, 'shared GUIDs in different full source revisions do not coalesce');
    assert.equal(JSON.stringify(saved), wireBefore); assert.equal(JSON.stringify(report), reportBefore);
    assert.deepEqual(models.map(model => hash(model.ifcDataStore.source.materialize())), sourceHashes);
    assert.deepEqual(live.map(model => hash(model.source.materialize())), sourceHashes);
    console.info('7372-real-information-portable-prerequisites', JSON.stringify({ models: count, nativeApplicable: spec.applicableCount,
      nativeFailed: spec.failedCount, nativeGuid: PINS.dataModified, bound: true, historical: true }));
  });
}
