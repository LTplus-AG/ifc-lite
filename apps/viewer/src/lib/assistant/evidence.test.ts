/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { summarizeClashes, type Clash } from '@ifc-lite/clash';
import { captureEvidence, evidenceJson, evidenceIsCurrent } from './evidence';
import { stampAnalysisReport, captureAnalysisStamp } from '@/hooks/useAnalysisStaleness';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));

// #6813: snapshot totals must describe the native report, not its bounded sample.
test('frozen clash evidence keeps full counts, federation keys and explicit sample coverage', () => {
  useViewerStore.setState(fixtureModels(fixtureModel('a'), fixtureModel('b', { idOffset: 1_000_000 })));
  const clashes: Clash[] = Array.from({ length: 120 }, (_, i) => ({
    id: `c${i}`, a: { key: `A${i}`, ref: i + 1, model: 'a', tag: 'IfcWall' },
    b: { key: `B${i}`, ref: 1_000_001 + i, model: 'b', tag: 'IfcPipeSegment' },
    rule: 'coordination', status: 'hard', severity: 'major', distance: -0.02, distanceKind: 'estimate',
    point: [0, 0, 0], bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  }));
  const result = stampAnalysisReport({ clashes, summary: summarizeClashes(clashes), rulesRun: [],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true } }, captureAnalysisStamp(true));
  useViewerStore.setState({ clashResult: result, clashRawResult: result });
  const snapshot = captureEvidence('clash');
  const payload = JSON.parse(snapshot.payload);
  assert.equal(payload.totalRows, 120);
  assert.equal(payload.includedRows, 100);
  assert.equal(payload.sampled, true);
  assert.equal(payload.evidence.summary.total, 120);
  assert.deepEqual(payload.models.map((m: { id: string }) => m.id), ['a', 'b']);
  assert.equal(payload.evidence.rows[0].data.b.model, 'b');
  assert.equal(payload.evidence.rows[0].data.distanceKind, 'estimate');
  assert.deepEqual(payload.evidence.rows[0].data.disciplineCandidates, { a: ['ARCH', 'STR'], b: ['MEP', 'FIRE'] });
  assert.match(payload.evidence.summary.taxonomyLimitations, /Omitted findings remain unclassified/);
  assert.match(payload.evidence.summary.taxonomyLimitations, /assignees stay empty/);
  const longNames = clashes.map(c => ({ ...c, a: { ...c.a, name: 'x'.repeat(20_000) }, b: { ...c.b, name: 'y'.repeat(20_000) } }));
  useViewerStore.setState({ clashResult: { ...result, clashes: longNames } });
  const limited = captureEvidence('clash');
  const limitedPayload = JSON.parse(limited.payload);
  assert.ok(limited.includedRows < 100, 'text budget must reduce the advertised sample');
  assert.equal(limited.includedRows, limitedPayload.evidence.rows.length);
  assert.equal(limited.projectionTruncated, true);
  assert.equal(limited.totalRows, 120);
  useViewerStore.setState({ clashResult: result });
  const text = snapshot.payload;
  clashes[0].severity = 'minor';
  assert.equal(snapshot.payload, text, 'the prompt is immutable after capture');
  assert.equal(evidenceIsCurrent(snapshot), true);
  useViewerStore.setState({ mutationVersion: initial.mutationVersion + 1 });
  assert.equal(evidenceIsCurrent(snapshot), false, 'model edits invalidate evidence');
});

test('projection bounds cycles, strings, breadth and binary payloads while reporting omissions', () => {
  const cyclic: { name: string; self?: unknown } = { name: 'x'.repeat(20_000) };
  cyclic.self = cyclic;
  const result = evidenceJson({ cyclic, data: new Uint8Array(2_000_000), rows: Array.from({ length: 300 }, (_, i) => ({ id: i })) });
  const value = JSON.parse(result.text);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length < 48_000);
  assert.equal(value.cyclic.name.length, 1200);
  assert.equal(value.cyclic.self, '[omitted: repeated reference]');
  assert.equal(value.data, undefined);
  assert.equal(value.rows.length, 100);
});

test('invalid numeric/date facts become explicit omissions rather than null values or throws (#6833)', () => {
  const result = evidenceJson({ distance: Number.NaN, amount: Number.POSITIVE_INFINITY, timestamp: new Date(Number.NaN), valid: 0 });
  const projected = JSON.parse(result.text);
  assert.equal(result.truncated, true);
  assert.equal(projected.distance, '[omitted: non-finite number]');
  assert.equal(projected.amount, '[omitted: non-finite number]');
  assert.equal(projected.timestamp, '[omitted: invalid date]');
  assert.equal(projected.valid, 0);
});

// Real ArchiCAD-authored fixture and native IDS engine provide independent counts (#6813).
test('IDS evidence preserves the native failure verdict on AC20-FZK-Haus', async context => {
  const { readFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const path = resolve(process.cwd(), '../../tests/models/ara3d/AC20-FZK-Haus.ifc');
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { context.skip('Run pnpm fixtures to fetch AC20-FZK-Haus.ifc'); return; }
    throw error;
  }
  assert.match(bytes.subarray(0, 4000).toString(), /ARCHICAD/);
  const { IfcParser } = await import('@ifc-lite/parser');
  const { parseIDS, validateIDS } = await import('@ifc-lite/ids');
  const { createDataAccessor } = await import('@/hooks/ids/idsDataAccessor');
  const array = Uint8Array.from(bytes);
  const store = await new IfcParser().parseColumnar(array.buffer, { disableWorkerScan: true });
  const walls = store.entityIndex.byType.get('IFCWALLSTANDARDCASE') ?? [];
  assert.ok(walls.length > 0, 'the fixture must actually contain walls');
  const document = parseIDS(`<ids xmlns="http://standards.buildingsmart.org/IDS">
    <info><title>Assistant evidence oracle</title></info><specifications>
    <specification name="Impossible wall name" ifcVersion="IFC4" identifier="wall-names">
    <applicability><entity><name><simpleValue>IFCWALLSTANDARDCASE</simpleValue></name></entity></applicability>
    <requirements><attribute cardinality="required"><name><simpleValue>Name</simpleValue></name>
    <value><simpleValue>AI_ORACLE_IMPOSSIBLE_NAME</simpleValue></value></attribute></requirements>
    </specification></specifications></ids>`);
  const info = { modelId: 'archicad', schemaVersion: 'IFC4' as const, entityCount: store.entities.count };
  const report = await validateIDS(document, createDataAccessor(store, 'archicad'), info);
  assert.equal(report.specificationResults[0].failedCount, walls.length);
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('archicad'), ifcDataStore: store }), idsValidationReport: report });
  const snapshot = captureEvidence('validation');
  const payload = JSON.parse(snapshot.payload);
  assert.equal(payload.evidence.summary.summary.totalEntitiesFailed, walls.length);
  assert.equal(payload.evidence.rows[0].data.status, 'fail');
  assert.equal(payload.evidence.rows[1].data.modelId, 'archicad');
  assert.equal(payload.evidence.rows[1].data.requirementResults[0].expectedValue, '"AI_ORACLE_IMPOSSIBLE_NAME"');
  assert.ok(snapshot.payload.length < 60_000);
});

// File-supplied model names must share the bounded prompt budget (#6813).
test('oversized model metadata is explicitly projected and keeps the full snapshot below its budget', () => {
  const models = Array.from({ length: 120 }, (_, i) => ({ ...fixtureModel(`m${i}`), name: 'x'.repeat(20_000) }));
  useViewerStore.setState(fixtureModels(...models));
  const snapshot = captureEvidence('clash');
  const payload = JSON.parse(snapshot.payload);
  assert.ok(snapshot.payload.length <= 48_000);
  assert.equal(payload.totalModels, 120);
  assert.equal(payload.modelMetadataTruncated, true);
  assert.equal(snapshot.models.length, 120, 'freshness retains all pins even when prompt metadata is omitted');
});

test('projection withholds credential-named fields wherever they appear (#6833)', () => {
  const result = evidenceJson({ apiKey: 'K1', name: 'kept', outputTokens: 12, nested: { accessToken: 'K2', client_secret: 'K3', Password: 'K4',
    headers: { Authorization: 'Bearer K5' } }, list: [{ refresh_token: 'K6', tokenCount: 3 }] });
  for (const secret of ['K1', 'K2', 'K3', 'K4', 'K5', 'K6']) assert.ok(!result.text.includes(secret), secret);
  const projected = JSON.parse(result.text);
  assert.equal(projected.apiKey, '[omitted: credential]');
  assert.deepEqual([projected.name, projected.outputTokens, projected.list[0].tokenCount], ['kept', 12, 3]);
});
