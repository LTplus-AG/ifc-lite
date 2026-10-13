/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS, validateIDS } from '@ifc-lite/ids';
import { createDataAccessor } from '@ifc-lite/ids/bridge';
import { NativeReviewCaptures, createNativeReviewIdentityTable, readPortableReview, validationFindings,
  type NativeReviewModel, type SavedAnalysisRun, type SavedValidationReport } from './review.js';
const samples = new URL('../../../apps/viewer/public/samples/', import.meta.url);
const xml = readFileSync(new URL('building-architecture.ids', samples), 'utf8');
async function fixture(file = 'building-architecture.ifc', id = 'live-a') {
  const bytes = new Uint8Array(readFileSync(new URL(file, samples)));
  const hash = createHash('sha256').update(bytes).digest('hex');
  const store = await new IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
  const model: NativeReviewModel = { id, name: 'same-display-name.ifc', owner: store, store, source: store.source,
    mutationView: () => null, identityTable: createNativeReviewIdentityTable(store),
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
it('#7372 duplicate source owners, absent table, capacity and known credentials refuse whole reads', async () => {
  const f = await fixture();
  const request = { savedAnalysisRuns: [f.analysis] };
  const duplicate = await f.read(request, [f.model, { ...f.model, id: 'duplicate-loaded-source' }]);
  expect(duplicate.sources[0]).toMatchObject({ state: 'unavailable', refusal: 'source-ambiguous' });
  const absent = await f.read(request, [{ ...f.model, identityTable: undefined }]);
  expect(absent.sources[0]).toMatchObject({ refusal: 'identity-unavailable' });
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
