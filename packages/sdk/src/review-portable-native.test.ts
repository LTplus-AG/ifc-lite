/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createClashEngine, type ClashElement } from '@ifc-lite/clash';
import { expect, it } from 'vitest';
import { IfcParser, createSyntheticDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { parseIDS, validateIDS } from '@ifc-lite/ids';
import { createDataAccessor } from '@ifc-lite/ids/bridge';
import * as review from './review.js';
import { NativeReviewCaptures, validationFindings, type NativeReviewModel, type SavedAnalysisRun, type SavedValidationReport } from './review.js';
const { createNativeReviewIdentityTable, readPortableReview } = review;
const samples = new URL('../../../apps/viewer/public/samples/', import.meta.url);
const xml = readFileSync(new URL('building-architecture.ids', samples), 'utf8');
async function fixture(file = 'building-architecture.ifc', id = 'live-a') {
  const bytes = new Uint8Array(readFileSync(new URL(file, samples)));
  const hash = createHash('sha256').update(bytes).digest('hex');
  const store = await new IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
  const model: NativeReviewModel = { id, name: 'same-display-name.ifc', owner: store, store, source: store.source,
    mutationView: () => null, ...(typeof createNativeReviewIdentityTable === 'function' ? { identityTable: createNativeReviewIdentityTable(store) } : {}),
    expressIdOf: GlobalId => store.entities.getExpressIdByGlobalId(GlobalId), globalIdOf: expressId => store.entities.getGlobalId(expressId) ?? '' };
  const report = await validateIDS(parseIDS(xml), createDataAccessor(store), { modelId: 'saved-key',
    schemaVersion: store.schemaVersion, entityCount: store.entityCount }, { includePassingEntities: true });
  expect(report.specificationResults.every(spec => !spec.error)).toBe(true);
  const analysis: SavedAnalysisRun = { version: 1, kind: 'validation', id: `run-${id}`, capturedAt: report.timestamp.toISOString(),
    savedAt: report.timestamp.toISOString(), freshness: 'current', edited: false, placementRecorded: false, frame: null,
    models: [{ key: 'saved-key', name: file, sourceContentHash: hash }], examined: ['saved-key'],
    report: { ...report, timestamp: report.timestamp.toISOString() }, ruleSet: null };
  const failures = validationFindings({ report, stale: false }, [{ ...model, id: 'saved-key' }]);
  expect(failures.findings.length).toBeGreaterThan(0);
  const saved: SavedValidationReport = { id: `report-${id}`, name: 'Original native failures', snapshot: {
    kind: 'ids-report', id: `block-${id}`, generatedAt: report.timestamp.toISOString(), sourceName: 'Building Architecture IDS',
    summary: { checked: report.summary.totalEntitiesChecked, passed: report.summary.totalEntitiesPassed,
      failed: report.summary.totalEntitiesFailed, passRate: report.summary.overallPassRate },
    checks: [], reportModels: [{ name: file, sourceContentHash: hash }],
    elementEvidence: { version: 1, observed: failures.findings.length, omitted: 0, gaps: [], rows: failures.findings.map((finding, index) => ({
      id: `row-${index}`, specificationId: finding.evidence.kind === 'validation' ? finding.evidence.specificationId : '',
      GlobalId: finding.elements[0]?.globalId ?? null, modelName: file, modelContentHash: hash, ifcType: finding.elements[0]?.ifcType ?? '',
      title: finding.title, nativeStatus: 'failed', detail: finding.detail })) } } };
  const captures = new NativeReviewCaptures();
  if (typeof readPortableReview !== 'function' || typeof createNativeReviewIdentityTable !== 'function') {
    // Changed-tests full-original control: exercise the surviving real owner,
    // not a missing-function exception or a manufactured portable return value.
    const token = await captures.begin('ids', xml, [model], () => [model], () => true);
    expect(token).not.toBeNull();
    const nativeReport = await validateIDS(parseIDS(xml), createDataAccessor(store), {
      modelId: id, schemaVersion: store.schemaVersion, entityCount: store.entityCount,
    });
    captures.finish(token, nativeReport);
    const historicalRequest = { sources: ['validation'], maxFindings: 512, savedAnalysisRuns: [analysis], savedValidationReports: [saved] };
    const native = await review.readNativeReview(captures, () => [model], historicalRequest, () => true);
    expect(native.findings.length).toBeGreaterThan(0);
    expect(native.provenance).toHaveLength(1);
    expect(native.provenance[0].sources[0].sourceSHA256).toBe(hash);
    expect(native.bounds.knownFindingsScope, `original owner performed actual IDS: ${JSON.stringify({ findings: native.findings.length,
      provenance: native.provenance.length, sourceProofMatches: native.provenance[0].sources[0].sourceSHA256 === hash })}`)
      .toBe('supplied-historical-records');
    throw new Error('Native context owner does not import supplied historical records');
  }
  const read = (request: Parameters<typeof readPortableReview>[2], models = [model]) =>
    readPortableReview(captures, () => models, { sources: ['validation'], maxFindings: 512, ...request }, () => true);
  return { model, store, hash, report, analysis, saved, failures, captures, read };
}
it('#7372 both real native IDS wire formats bind after reload/rename without becoming current', async () => {
  const f = await fixture();
  const payload = JSON.parse(JSON.stringify({ savedAnalysisRuns: [f.analysis], savedValidationReports: [f.saved] }));
  const original = JSON.stringify(payload);
  const result = await f.read({ ...payload, sources: undefined });
  expect(result.origin).toBe('imported'); expect(result.provenance).toEqual([]);
  expect(result.sources.find(source => source.source === 'validation')).toMatchObject({ state: 'available' });
  expect(result.sources.find(source => source.source === 'clash')).toMatchObject({ state: 'not-run' });
  expect(result.bounds.knownFindingsScope).toBe('supplied-historical-records');
  expect(result.bindings.map(binding => binding.state)).toEqual(['bound', 'bound']);
  expect(result.findings).toHaveLength(f.failures.findings.length * 2);
  expect(result.findings.every(finding => finding.lifecycle === 'not-evaluated' && finding.run.temporal === 'historical' && !finding.run.complete)).toBe(true);
  expect(result.cards.every(card => card.identity === 'validated' && card.state === 'not-evaluated')).toBe(true);
  expect(result.bounds.nativeCoverageComplete).toBe(false);
  expect(result.records.map(record => record.value)).toEqual([f.analysis, f.saved]);
  expect(JSON.stringify(payload)).toBe(original);
  expect(createHash('sha256').update(f.store.source.materialize()).digest('hex')).toBe(f.hash);
}, 20_000);
it('#7372 full source identity keeps same-GUID cards distinct with identical display filenames', async () => {
  const a = await fixture(), b = await fixture('building-architecture-rev-b.ifc', 'live-b');
  const result = await a.read({ savedAnalysisRuns: [a.analysis, b.analysis] }, [b.model, a.model]);
  expect(result.bindings.every(binding => binding.state === 'bound')).toBe(true);
  expect(result.cards.every(card => card.identity === 'validated')).toBe(true);
  const common = result.findings.filter(finding => finding.elements.some(element =>
    a.model.expressIdOf(element.globalId) > 0 && b.model.expressIdOf(element.globalId) > 0));
  expect(common.length).toBeGreaterThan(0);
  for (const finding of common) {
    const card = result.cards.find(candidate => candidate.findings.includes(finding));
    expect(card?.elements.every(element => element.resolvedModelId === finding.elements[0].modelId)).toBe(true);
  }
  expect(result.totals.uniqueElements).toBe(new Set(result.findings.flatMap(finding => finding.elements.map(element => `${element.modelId}:${element.globalId}`))).size);
  const lineageOwners = new Map<string, string>();
  for (const finding of common) {
    const owner = finding.elements[0].modelId;
    expect(owner).not.toBeNull();
    const previous = lineageOwners.get(finding.lineage);
    expect(previous === undefined || previous === owner).toBe(true);
    if (owner) lineageOwners.set(finding.lineage, owner);
  }
}, 20_000);
it('#7372 legacy, mismatched source and conflicting GUID remain historical and unvalidated', async () => {
  const f = await fixture();
  for (const change of ['legacy', 'different-source', 'conflict'] as const) {
    const record = structuredClone(f.analysis);
    if (change === 'legacy') delete record.models[0].sourceContentHash;
    else if (change === 'different-source') record.models[0].sourceContentHash = '0'.repeat(64);
    else {
      if (record.kind !== 'validation') throw new Error('Expected actual IDS wire');
      record.report.specificationResults[0].entityResults[0].globalId = 'wrong-recorded-guid';
    }
    const result = await f.read({ savedAnalysisRuns: [record] });
    expect(result.bindings[0]?.state).toBe('unbound');
    expect(result.cards.every(card => card.identity === 'unvalidated')).toBe(true);
    expect(result.findings.every(finding => finding.lifecycle === 'not-evaluated')).toBe(true);
    expect(result.bounds.nativeCoverageComplete).toBe(false);
  }
}, 20_000);
it('#7372 duplicate source owners, capacity and credentials refuse while absent identity remains unbound', async () => {
  const f = await fixture();
  const request = { savedAnalysisRuns: [f.analysis] };
  const duplicate = await f.read(request, [f.model, { ...f.model, id: 'duplicate-loaded-source' }]);
  expect(duplicate.sources[0]).toMatchObject({ state: 'unavailable', refusal: 'source-ambiguous' });
  const absent = await f.read(request, [{ ...f.model, identityTable: undefined }]);
  expect(absent.bindings[0]).toMatchObject({ state: 'unbound', refusal: 'identity-unavailable' });
  expect(absent.records[0].value).toEqual(f.analysis);
  expect(absent.findings.every(finding => finding.lifecycle === 'not-evaluated')).toBe(true);
  const zero = await readPortableReview(new NativeReviewCaptures(0), () => [f.model], request, () => true);
  expect(zero.sources.find(source => source.source === 'validation')).toMatchObject({ refusal: 'work-bound' });
  f.captures.enrollCredentials([f.analysis.models[0].name]);
  const sensitive = await f.read(request);
  expect(sensitive.findings).toEqual([]); expect(sensitive.records).toEqual([]);
  expect(sensitive.sources[0]).toMatchObject({ refusal: 'sensitive-input' });
}, 20_000);
it('#7372 permission and identity ownership are rechecked after actual source hashing', async () => {
  const f = await fixture(); const original = f.store.source.withMaterializedAsync.bind(f.store.source);
  let permitted = true;
  try {
    f.store.source.withMaterializedAsync = async fn => { const result = await original(fn); permitted = false; return result; };
    const denied = await readPortableReview(f.captures, () => [f.model], { savedAnalysisRuns: [f.analysis], sources: ['validation'] }, () => permitted);
    expect(denied.findings).toEqual([]); expect(denied.sources[0]).toMatchObject({ refusal: 'target-changed' });
    permitted = true;
    f.store.source.withMaterializedAsync = async fn => { const result = await original(fn); f.captures.enrollCredentials([f.model.name]); return result; };
    const secret = await f.read({ savedAnalysisRuns: [f.analysis] });
    expect(secret.findings).toEqual([]); expect(secret.sources[0]).toMatchObject({ refusal: 'sensitive-input' });
  } finally { f.store.source.withMaterializedAsync = original; }
}, 20_000);
it('#7372 actual column duplicate GUIDs cannot be hidden by a point-lookup map', async () => {
  const f = await fixture(); const table = f.store.entities;
  const rows = [...createNativeReviewIdentityTable(f.store).rows()].filter(row => row.GlobalId);
  expect(rows.length).toBeGreaterThan(1);
  const a = table.expressId.indexOf(rows[0].expressId), b = table.expressId.indexOf(rows[1].expressId);
  const original = table.globalId[b];
  try {
    table.globalId[b] = table.globalId[a];
    const result = await f.read({ savedAnalysisRuns: [f.analysis] });
    expect(result.findings).toEqual([]); expect(result.sources[0]).toMatchObject({ refusal: 'identity-ambiguous' });
  } finally { table.globalId[b] = original; }
}, 20_000);
it('#7372 cyclic supplied records are bounded before JSON encoding and never touch source', async () => {
  const f = await fixture(); const cycle: { child?: unknown } = {}; cycle.child = cycle;
  let sourceReads = 0; const original = f.store.source.withMaterializedAsync.bind(f.store.source);
  try {
    f.store.source.withMaterializedAsync = async fn => { sourceReads++; return original(fn); };
    const result = await f.read({ savedAnalysisRuns: [cycle] });
    expect(result.sources[0]).toMatchObject({ refusal: 'work-bound' }); expect(sourceReads).toBe(0);
  } finally { f.store.source.withMaterializedAsync = original; }
}, 20_000);
it('#7372 explicit empty supplied libraries differ from absent evidence without source work', async () => {
  // Full-original control must observe the real prior owner before any absent-API call.
  await fixture();
  const captures = new NativeReviewCaptures();
  const empty = await readPortableReview(captures, () => [], { savedValidationReports: [] }, () => true);
  expect(empty.sources.find(source => source.source === 'validation')).toMatchObject({ state: 'available' });
  expect(empty.sources.find(source => source.source === 'clash')).toMatchObject({ state: 'not-run' });
  expect(empty.bounds).toMatchObject({ knownFindings: 0, omittedFindings: 0, nativeCoverageComplete: false });
  const untypedEmpty = await readPortableReview(captures, () => [], { savedAnalysisRuns: [] }, () => true);
  expect(untypedEmpty.sources.filter(source => source.source === 'clash' || source.source === 'validation')
    .map(source => source.state)).toEqual(['not-run', 'not-run']);
  // These are counts of supplied rows, not proof of native source evaluation.
  expect(untypedEmpty.bounds).toMatchObject({ knownFindings: 0, knownFindingsScope: 'supplied-historical-records', nativeCoverageComplete: false });
  const absent = await readPortableReview(captures, () => [], {}, () => true);
  expect(absent.bounds.knownFindings).toBeNull();
  expect(absent.sources.find(source => source.source === 'validation')).toMatchObject({ state: 'unavailable', refusal: 'records-unavailable' });
});
it('#7372 oversized JSON property names refuse before credential serialization or native source reads', async () => {
  const f = await fixture();
  const control = await f.read({ savedAnalysisRuns: [f.analysis] });
  expect(control.bindings[0]).toMatchObject({ state: 'bound', refusal: null });
  expect(control.findings.length).toBeGreaterThan(0);
  const oversizedKey = { ['k'.repeat(16_385)]: 0 };
  const aggregateKeys: Record<string, number> = {};
  for (let i = 0; i < 129; i++) aggregateKeys[`${i}:` + 'k'.repeat(8_192)] = i;
  const originalRead = f.store.source.withMaterializedAsync.bind(f.store.source);
  const originalEvidence = f.captures.acceptsEvidence.bind(f.captures);
  let sourceReads = 0, serializations = 0;
  try {
    f.store.source.withMaterializedAsync = async fn => { sourceReads++; return originalRead(fn); };
    f.captures.acceptsEvidence = value => { serializations++; return originalEvidence(value); };
    for (const unknownKeys of [oversizedKey, aggregateKeys]) {
      const result = await f.read({ savedAnalysisRuns: [{ ...f.analysis, ...unknownKeys }] });
      expect(result.sources[0]).toMatchObject({ state: 'unavailable', refusal: 'work-bound' });
      expect(result.bounds.knownFindings).toBeNull(); expect(result.findings).toEqual([]);
      expect(sourceReads).toBe(0); expect(serializations).toBe(0);
    }
  } finally {
    f.store.source.withMaterializedAsync = originalRead;
    f.captures.acceptsEvidence = originalEvidence;
  }
  expect(createHash('sha256').update(f.store.source.materialize()).digest('hex')).toBe(f.hash);
}, 20_000);
it('#7372 a real count-only report retains its native counts without inventing an empty failure inventory', async () => {
  const f = await fixture(); const saved = structuredClone(f.saved);
  if (saved.snapshot.kind !== 'ids-report') throw new Error('Actual IDS snapshot required');
  delete saved.snapshot.elementEvidence;
  const result = await f.read({ savedValidationReports: [saved] });
  expect(result.records[0]?.value).toEqual(saved);
  expect(result.findings).toEqual([]);
  expect(result.bounds).toMatchObject({ knownFindings: null, omittedFindings: null, nativeCoverageComplete: false, presentationComplete: false });
  expect(result.runs[0]).toMatchObject({ temporal: 'historical', complete: false });
}, 20_000);
it('#7372 full source/GUID proof binds without a display name; missing GUID stays unbound', async () => {
  const f = await fixture(); const named = structuredClone(f.saved);
  if (named.snapshot.kind !== 'ids-report' || !named.snapshot.elementEvidence) throw new Error('Actual native failure rows required');
  for (const row of named.snapshot.elementEvidence.rows) row.modelName = null;
  const bound = await f.read({ savedValidationReports: [named] });
  expect(bound.bindings[0]).toMatchObject({ state: 'bound', refusal: null });
  expect(bound.cards.every(card => card.identity === 'validated')).toBe(true);
  expect(bound.findings.every(finding => !finding.detail.includes('Saved durable identity unavailable'))).toBe(true);
  const missing = structuredClone(named);
  if (missing.snapshot.kind !== 'ids-report' || !missing.snapshot.elementEvidence) throw new Error('Actual native failure rows required');
  missing.snapshot.elementEvidence.rows[0].GlobalId = null;
  const unbound = await f.read({ savedValidationReports: [missing] });
  expect(unbound.bindings[0]).toMatchObject({ state: 'unbound', refusal: 'identity-unmatched' });
  expect(unbound.cards.every(card => card.identity === 'unvalidated')).toBe(true);
  expect(unbound.records[0]?.value).toEqual(missing);
}, 20_000);

// #7372 / review4254762942: retained rows do not certify a complete source inventory.
it('#7372 actual saved IDS omissions and gaps keep complete inventory bounds unknown', async () => {
  const f = await fixture();
  const control = await f.read({ savedValidationReports: [f.saved] });
  expect(control.findings.length).toBe(f.failures.findings.length);
  expect(control.bounds).toMatchObject({ knownFindings: f.failures.findings.length, omittedFindings: 0 });
  for (const gap of [false, true]) {
    const saved = structuredClone(f.saved);
    if (saved.snapshot.kind !== 'ids-report' || !saved.snapshot.elementEvidence) throw new Error('Actual saved IDS rows required');
    const evidence = saved.snapshot.elementEvidence;
    if (gap) evidence.gaps.push('Native source coverage was bounded');
    else { evidence.omitted = 3; evidence.observed = evidence.rows.length + 3; }
    const result = await f.read({ savedValidationReports: [saved] });
    expect(result.records[0]?.value).toEqual(saved);
    expect(result.findings.map(row => row.nativeStatus)).toEqual(control.findings.map(row => row.nativeStatus));
    expect(result.bindings[0]?.state).toBe('bound');
    expect(result.bounds).toMatchObject({ knownFindings: null, omittedFindings: null, presentationComplete: false, nativeCoverageComplete: false });
  }
  expect(createHash('sha256').update(f.store.source.materialize()).digest('hex')).toBe(f.hash);
}, 20_000);
// #7372 / review4260900431: an empty/partial imported detail collection does
// not erase the actual native entity-failure counts that travel in its record.
it('#7372 actual native IDS entity failures cannot become a complete empty or partial inventory', async () => {
  const f = await fixture();
  const original = structuredClone(f.saved);
  if (original.snapshot.kind !== 'ids-report' || !original.snapshot.elementEvidence) throw new Error('Actual native IDS evidence required');
  const failed = original.snapshot.summary.failed;
  expect(failed).toBeGreaterThan(1);
  expect(original.snapshot.elementEvidence.rows).toHaveLength(failed);
  const complete = await f.read({ savedValidationReports: [original] });
  expect(complete.bounds).toMatchObject({ knownFindings: failed, omittedFindings: 0, presentationComplete: true });
  for (const retained of [0, failed - 1]) {
    const saved = structuredClone(original);
    if (saved.snapshot.kind !== 'ids-report' || !saved.snapshot.elementEvidence) throw new Error('Actual native IDS evidence required');
    saved.snapshot.elementEvidence.rows = saved.snapshot.elementEvidence.rows.slice(0, retained);
    saved.snapshot.elementEvidence.observed = retained;
    expect(review.validateSavedReport(saved), 'wire compatibility and recorded native counts remain intact').toBe(true);
    const result = await f.read({ savedValidationReports: [saved] });
    expect(result.records[0]?.value).toEqual(saved);
    expect(result.bindings[0]?.state).toBe('bound');
    expect(result.findings).toHaveLength(retained);
    expect(result.findings.every(row => row.lifecycle === 'not-evaluated')).toBe(true);
    expect(result.bounds).toMatchObject({ knownFindings: null, omittedFindings: null, presentationComplete: false, nativeCoverageComplete: false });
  }
}, 20_000);

it('#7372 real zero-applicability cardinality failure retains its genuinely empty element inventory', async () => {
  const f = await fixture();
  const definition = parseIDS(`<ids xmlns="http://standards.buildingsmart.org/IDS"><info><title>Required chiller</title></info>
    <specifications><specification name="Required chiller" ifcVersion="IFC4"><applicability minOccurs="1" maxOccurs="unbounded">
      <entity><name><simpleValue>IFCCHILLER</simpleValue></name></entity></applicability><requirements>
      <attribute><name><simpleValue>GlobalId</simpleValue></name></attribute></requirements></specification></specifications></ids>`);
  const native = await validateIDS(definition, createDataAccessor(f.store), {
    modelId: f.model.id, schemaVersion: f.store.schemaVersion, entityCount: f.store.entityCount,
  }, { includePassingEntities: true });
  expect(native.specificationResults[0].error).toBeUndefined();
  expect(native.specificationResults[0].applicableCount).toBe(0);
  expect(native.specificationResults[0].cardinalityResult?.passed).toBe(false);
  expect(native.summary.failedSpecifications).toBe(1);
  expect(native.summary.totalEntitiesFailed).toBe(0);
  expect(validationFindings({ report: native, stale: false }, [f.model]).findings).toEqual([]);
  const saved = structuredClone(f.saved);
  if (saved.snapshot.kind !== 'ids-report' || !saved.snapshot.elementEvidence) throw new Error('Actual native IDS evidence required');
  saved.snapshot.generatedAt = native.timestamp.toISOString();
  saved.snapshot.sourceName = definition.info.title;
  saved.snapshot.summary = { checked: native.summary.totalEntitiesChecked, passed: native.summary.totalEntitiesPassed,
    failed: native.summary.totalEntitiesFailed, passRate: native.summary.overallPassRate };
  saved.snapshot.checks = native.specificationResults.map(spec => ({ id: spec.specification.id,
    shortDescription: spec.specification.name, checked: spec.applicableCount, passed: spec.passedCount,
    failed: spec.failedCount, passRate: spec.passRate, rules: [] }));
  saved.snapshot.elementEvidence.rows = [];
  saved.snapshot.elementEvidence.observed = 0;
  expect(review.validateSavedReport(saved)).toBe(true);
  const result = await f.read({ savedValidationReports: [saved] });
  expect(result.records[0]?.value).toEqual(saved);
  expect(result.bindings[0]?.state).toBe('bound');
  expect(result.findings).toEqual([]);
  expect(result.bounds).toMatchObject({ knownFindings: 0, omittedFindings: 0, presentationComplete: true, nativeCoverageComplete: false });
}, 20_000);

it('#7372 supplied warning history preserves its separate entity-count bucket and missing-detail uncertainty', async () => {
  const f = await fixture();
  const saved = structuredClone(f.saved);
  if (saved.snapshot.kind !== 'ids-report' || !saved.snapshot.elementEvidence) throw new Error('Actual native IDS rows required');
  // Exercise the imported wire's warning bucket with real IFC identities and
  // IDS-produced failure rows. This reclassification is supplied history, not
  // a claim that the IDS engine produced a native warning-severity rules run.
  saved.snapshot.sourceKind = 'rules';
  saved.snapshot.summary.warnings = saved.snapshot.summary.failed;
  saved.snapshot.summary.failed = 0;
  for (const row of saved.snapshot.elementEvidence.rows) row.nativeStatus = 'warning';
  const warnings = saved.snapshot.summary.warnings;
  expect(warnings).toBeGreaterThan(0);
  expect(review.validateSavedReport(saved)).toBe(true);
  const complete = await f.read({ savedValidationReports: [saved] });
  expect(complete.records[0]?.value).toEqual(saved);
  expect(complete.findings).toHaveLength(warnings);
  expect(complete.findings.every(row => row.nativeStatus === 'warning' && row.lifecycle === 'not-evaluated')).toBe(true);
  expect(complete.bounds).toMatchObject({ knownFindings: warnings, omittedFindings: 0, presentationComplete: true, nativeCoverageComplete: false });
  saved.snapshot.elementEvidence.rows = [];
  saved.snapshot.elementEvidence.observed = 0;
  const missing = await f.read({ savedValidationReports: [saved] });
  expect(missing.records[0]?.value).toEqual(saved);
  expect(missing.findings).toEqual([]);
  expect(missing.bounds).toMatchObject({ knownFindings: null, omittedFindings: null, presentationComplete: false, nativeCoverageComplete: false });
}, 20_000);

it('#7372 actual bounded IDS evaluation and truncated set detail never certify full presentation', async () => {
  const f = await fixture();
  const report = await validateIDS(parseIDS(xml), createDataAccessor(f.store), { modelId: 'saved-key',
    schemaVersion: f.store.schemaVersion, entityCount: f.store.entityCount }, { maxEntities: 1, includePassingEntities: true });
  expect(report.specificationResults.some(spec => spec.passedCount + spec.failedCount < spec.applicableCount)).toBe(true);
  if (f.analysis.kind !== 'validation') throw new Error('Actual IDS wire required');
  const partial: SavedAnalysisRun = { ...f.analysis, report: { ...report, timestamp: report.timestamp.toISOString() } };
  const setDetail = structuredClone(f.analysis);
  setDetail.report.specificationResults[0].setResultsTruncated = true;
  for (const saved of [partial, setDetail]) {
    const result = await f.read({ savedAnalysisRuns: [saved] });
    expect(result.records[0]?.value).toEqual(saved);
    expect(result.bindings[0]?.state).toBe('bound');
    expect(result.bounds).toMatchObject({ knownFindings: null, omittedFindings: null, presentationComplete: false });
    expect(result.runs[0]?.incomplete.some(gap => gap.code === 'truncated' || gap.code === 'sets-truncated')).toBe(true);
  }
}, 20_000);
it('#7372 real clash engine truncation stays unknown while retained clashes bind by saved EXPRESS ids', async () => {
  const f = await fixture();
  const rows = [...createNativeReviewIdentityTable(f.store).rows()].filter(row => row.GlobalId
    && f.store.entities.getTypeName(row.expressId) === 'IfcWall').slice(0, 3);
  expect(rows).toHaveLength(3);
  // Controlled overlapping closed cubes exercise the real TS producer. Their
  // identity comes from actual IFC rows; no authored-geometry/WASM claim is made.
  const corners = [-1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1, -1,-1,1, 1,-1,1, 1,1,1, -1,1,1];
  const indices = new Uint32Array([0,1,2,0,2,3,4,6,5,4,7,6,0,4,5,0,5,1,1,5,6,1,6,2,2,6,7,2,7,3,3,7,4,3,4,0]);
  const elements: ClashElement[] = rows.map((row, index) => ({ key: `expressid:${row.expressId}`, ref: row.expressId,
    model: 'saved-key', tag: 'IfcWall', positions: new Float32Array(corners.map((n, i) => n + (i % 3 === 0 ? index * 0.2 : 0))), indices,
    bounds: { min: [-1 + index * 0.2, -1, -1], max: [1 + index * 0.2, 1, 1] } }));
  const engine = createClashEngine({ backend: 'ts' });
  const rules = [{ id: 'overlap', name: 'Controlled overlap', a: 'IfcWall', mode: 'hard' as const }];
  for (const limit of [undefined, 1]) {
    const native = await engine.run(elements, rules, { maxCandidatePairs: limit });
    expect(native.clashes.length).toBeGreaterThan(0);
    expect(Boolean(native.truncated)).toBe(limit !== undefined);
    const saved: SavedAnalysisRun = { version: 1, kind: 'clash', id: 'actual-capped-clash', capturedAt: f.analysis.capturedAt,
      savedAt: f.analysis.savedAt, models: f.analysis.models, examined: ['saved-key'], freshness: 'current', edited: false,
      placementRecorded: false, frame: null, result: { ...native, clashes: native.clashes.map(({ a, b, ...clash }) => ({ ...clash,
        a: { key: a.key, model: a.model, tag: a.tag, expressId: a.ref },
        b: { key: b.key, model: b.model, tag: b.tag, expressId: b.ref } })) } };
    const result = await f.read({ savedAnalysisRuns: [saved], sources: ['clash'] });
    expect(result.records[0]?.value).toEqual(saved);
    expect(result.bindings[0]?.state).toBe('bound');
    expect(result.findings).toHaveLength(native.clashes.length);
    expect(result.findings.every(row => row.elements.every(element => element.modelId === f.model.id
      && rows.some(actual => actual.GlobalId === element.globalId)))).toBe(true);
    expect(result.bounds).toMatchObject(limit === undefined
      ? { knownFindings: native.clashes.length, omittedFindings: 0 }
      : { knownFindings: null, omittedFindings: null, presentationComplete: false });
  }
}, 20_000);
it('#7372 zero presentation cap preserves real supplied facts and discloses every hidden finding', async () => {
  const f = await fixture(); const result = await f.read({ savedAnalysisRuns: [f.analysis], maxFindings: 0 });
  expect(f.failures.findings.length).toBeGreaterThan(0);
  expect(result.records[0]?.value).toEqual(f.analysis);
  expect(result.cards).toEqual([]); expect(result.findings).toEqual([]);
  expect(result.bounds).toMatchObject({ knownFindings: f.failures.findings.length,
    omittedFindings: f.failures.findings.length, presentationComplete: false, nativeCoverageComplete: false });
  expect(result.sources.every(source => !Object.hasOwn(source, 'refusal'))).toBe(true);
}, 20_000);

it('#7372 unsupported manual projection retains unanswered history without certifying element binding', async () => {
  const f = await fixture();
  const saved: SavedValidationReport = { id: 'unanswered-manual', name: 'Unanswered checklist', snapshot: {
    kind: 'manual-report', id: 'empty-manual-block', generatedAt: f.analysis.capturedAt, checklistName: 'Not evaluated',
    summary: { total: 0, pass: 0, fail: 0, warning: 0, unanswered: 0 }, groups: [],
    reportModels: [{ name: f.model.name, sourceContentHash: f.hash }] } };
  const result = await f.read({ savedValidationReports: [saved] });
  expect(result.records[0]?.value).toEqual(saved);
  expect(result.bindings[0]).toMatchObject({ state: 'unbound', refusal: 'unsupported-kind' });
  expect(result.findings).toEqual([]);
  expect(result.bounds).toMatchObject({ knownFindings: null, omittedFindings: null, presentationComplete: false, nativeCoverageComplete: false });
}, 20_000);

function syntheticReviewPeer(): NativeReviewModel {
  // Public producer used by canonical GLB/point-cloud stores: real tables and
  // EMPTY_SOURCE_BYTES, not a fake byteLength getter or a mocked parser result.
  const store = createSyntheticDataStore({ schemaVersion: 'IFC4', fileSize: 0,
    entities: [{ expressId: 1, type: 'IfcGeographicElement', name: 'Imported point-cloud entity',
      globalId: '0SyntheticCloudPeer0000' }] });
  return { id: 'source-free-peer', name: 'Synthetic imported cloud', owner: store, store, source: store.source,
    mutationView: () => null, identityTable: createNativeReviewIdentityTable(store),
    expressIdOf: GlobalId => store.entities.getExpressIdByGlobalId(GlobalId),
    globalIdOf: id => store.entities.getGlobalId(id) };
}

it('#7372 unrelated edited authored and source-free peers preserve supplied native history', async () => {
  const a = await fixture('building-architecture.ifc', 'eligible-A'), b = await fixture('building-architecture-rev-b.ifc', 'edited-B');
  const view = new MutablePropertyView(null, b.model.id);
  view.setAttribute(b.store.entities.expressId[0], 'Name', 'Actual B overlay edit');
  expect(view.getMutationRevision()).toBeGreaterThan(0);
  const edited: NativeReviewModel = { ...b.model, mutationView: () => view }, synthetic = syntheticReviewPeer();
  expect(synthetic.source.byteLength).toBe(0);
  expect(synthetic.identityTable?.count).toBe(1);
  const models = [a.model, edited, synthetic];
  const result = await a.read({ savedAnalysisRuns: [a.analysis, b.analysis] }, models);
  expect(result.records.map(record => record.value)).toEqual([a.analysis, b.analysis]);
  expect(result.bindings.find(binding => binding.id === a.analysis.id)).toMatchObject({ state: 'bound', refusal: null });
  expect(result.bindings.find(binding => binding.id === b.analysis.id)).toMatchObject({ state: 'unbound', refusal: 'model-edited' });
  const AGuids = result.findings.filter(finding => finding.elements.some(element => element.modelId === a.model.id))
    .flatMap(finding => finding.elements.map(element => element.globalId)).sort();
  expect(AGuids).toEqual(a.failures.findings.flatMap(finding => finding.elements.map(element => element.globalId)).sort());
  expect(result.findings.every(finding => finding.lifecycle === 'not-evaluated')).toBe(true);
  expect(result.bounds.nativeCoverageComplete).toBe(false);
  expect(createHash('sha256').update(a.store.source.materialize()).digest('hex')).toBe(a.hash);
  expect(createHash('sha256').update(b.store.source.materialize()).digest('hex')).toBe(b.hash);
  const scoped = await a.read({ savedAnalysisRuns: [a.analysis], modelIds: [a.model.id] }, models);
  expect(scoped.bindings[0]).toMatchObject({ state: 'bound' });
  expect(scoped.findings.map(finding => finding.lineage)).toEqual(result.findings
    .filter(finding => finding.elements.some(element => element.modelId === a.model.id)).map(finding => finding.lineage));
}, 30_000);

for (const unavailable of ['edited', 'identity'] as const) {
  it(`#7372 ${unavailable} same-source peer cannot disappear from duplicate-source proof`, async () => {
    const a = await fixture('building-architecture.ifc', 'same-A'), b = await fixture('building-architecture.ifc', 'same-B');
    const view = new MutablePropertyView(null, b.model.id);
    view.setAttribute(b.store.entities.expressId[0], 'Name', 'Same source with actual edit');
    const peer: NativeReviewModel = unavailable === 'edited'
      ? { ...b.model, mutationView: () => view } : { ...b.model, identityTable: undefined };
    const result = await a.read({ savedAnalysisRuns: [a.analysis] }, [a.model, peer]);
    expect(result.sources[0]).toMatchObject({ state: 'unavailable', refusal: 'source-ambiguous' });
    expect(result.bounds.knownFindings).toBeNull(); expect(result.findings).toEqual([]);
  }, 30_000);
}

it('#7372 identity-less distinct authored peer leaves only its own native record unbound', async () => {
  const a = await fixture('building-architecture.ifc', 'identity-A'), b = await fixture('building-architecture-rev-b.ifc', 'identity-B');
  const peer = { ...b.model, identityTable: undefined };
  const result = await a.read({ savedValidationReports: [a.saved, b.saved] }, [a.model, peer]);
  expect(result.records.map(record => record.value)).toEqual([a.saved, b.saved]);
  expect(result.bindings.find(binding => binding.id === a.saved.id)).toMatchObject({ state: 'bound' });
  expect(result.bindings.find(binding => binding.id === b.saved.id)).toMatchObject({ state: 'unbound', refusal: 'identity-unavailable' });
}, 30_000);

for (const change of ['eligibility', 'source', 'revision', 'membership', 'permission'] as const) {
  it(`#7372 excluded-peer ${change} change during actual source hashing refuses the whole lease`, async () => {
    const a = await fixture('building-architecture.ifc', 'lease-A'), b = await fixture('building-architecture-rev-b.ifc', 'lease-B');
    const view = new MutablePropertyView(null, b.model.id);
    view.setAttribute(b.store.entities.expressId[0], 'Name', 'Initial excluded B edit');
    let peer: NativeReviewModel = change === 'source' ? syntheticReviewPeer()
      : change === 'eligibility' ? { ...b.model, identityTable: undefined }
      : { ...b.model, mutationView: () => view };
    let live = [a.model, peer]; const permitted = new Set(live.map(model => model.id));
    const source = a.store.source, original = source.withMaterializedAsync.bind(source);
    let release: () => void = () => { /* No owned hash promise exists yet. */ };
    let pending: ReturnType<typeof readPortableReview> | undefined;
    try {
      let reached: () => void = () => { throw new Error('Actual hash barrier not installed'); };
      const ready = new Promise<void>(resolve => { reached = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      source.withMaterializedAsync = async fn => { const result = await original(fn); reached(); await held; return result; };
      pending = readPortableReview(a.captures, () => live,
        { sources: ['validation'], savedAnalysisRuns: [a.analysis] }, id => permitted.has(id));
      // A pre-hash domain refusal must fail promptly rather than leave this
      // observer awaiting a hash callback that the old policy never starts.
      const started = await Promise.race([ready.then(() => 'held' as const), pending.then(() => 'settled' as const)]);
      expect(started).toBe('held');
      if (change === 'eligibility') { peer = { ...peer, identityTable: createNativeReviewIdentityTable(b.store) }; live = [a.model, peer]; }
      else if (change === 'source') { peer = { ...peer, owner: b.store, store: b.store, source: b.store.source }; live = [a.model, peer]; }
      else if (change === 'revision') view.setAttribute(b.store.entities.expressId[0], 'Name', 'Later excluded B edit');
      else if (change === 'membership') live = [a.model];
      else permitted.delete(peer.id);
      release(); const result = await pending;
      expect(result.sources[0]).toMatchObject({ state: 'unavailable', refusal: 'target-changed' });
      expect(result.records).toEqual([]); expect(result.findings).toEqual([]);
      expect(result.bounds.knownFindings).toBeNull();
      expect(createHash('sha256').update(a.store.source.materialize()).digest('hex')).toBe(a.hash);
    } finally { release(); if (pending) await Promise.allSettled([pending]); source.withMaterializedAsync = original; }
  }, 30_000);
}
