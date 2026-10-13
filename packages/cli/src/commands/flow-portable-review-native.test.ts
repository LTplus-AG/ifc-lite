/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { parseIDS, validateIDS } from '@ifc-lite/ids';
import { createDataAccessor } from '@ifc-lite/ids/bridge';
import { parseFlowDocument, runFlow } from '@ifc-lite/flow';
import { createStandardRegistry, headlessFeatures } from '@ifc-lite/flow-nodes';
import { createHeadlessContext } from '../loader.js';
import { createCliFlowSession } from './flow-host.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

it('#7372 actual CLI Flow host imports saved native IDS facts through an exported graph without allocating an editor', async () => {
  const samples = new URL('../../../../apps/viewer/public/samples/', import.meta.url);
  const model = await createHeadlessContext(new URL('building-architecture.ifc', samples).pathname);
  const id = model.bim.model.activeId();
  if (!id) throw new Error('Actual CLI model id required');
  const bytes = model.store.source.materialize();
  const hash = createHash('sha256').update(bytes).digest('hex');
  const xml = await readFile(new URL('building-architecture.ids', samples), 'utf8');
  const report = await validateIDS(parseIDS(xml), createDataAccessor(model.store), {
    modelId: id, schemaVersion: model.store.schemaVersion, entityCount: model.store.entityCount,
  });
  for (const spec of report.specificationResults) {
    expect(spec.error).toBeFalsy();
    expect(spec.setResultsTruncated).not.toBe(true);
    expect(spec.entityResults.length).toBe(spec.applicableCount);
  }
  const failures = report.specificationResults.flatMap(spec => spec.entityResults.filter(entity => !entity.passed));
  expect(failures.length).toBeGreaterThan(0);
  expect(model.backend.getMutationView()).toBeNull();
  const saved = JSON.parse(JSON.stringify({ version: 1, id: 'actual-cli-native-report',
    capturedAt: report.timestamp.toISOString(), savedAt: report.timestamp.toISOString(),
    models: [{ key: id, name: model.bim.model.active()?.name, sourceContentHash: hash }], examined: [id],
    freshness: 'current', edited: false, placementRecorded: false, frame: null, kind: 'validation', report, ruleSet: null }));
  // Export/import is the real Flow wire boundary, preserving the supplied
  // historical input instead of a separate private host argument.
  const graph = parseFlowDocument(JSON.stringify({ flowVersion: 1, id: '7372-portable-cli', name: 'Saved native evidence',
    capabilities: ['model.read'], inputs: [], edges: [], outputs: [{ nodeId: 'read', port: 'snapshot', label: 'Historical Review' }],
    nodes: [{ id: 'read', type: 'review.snapshot', params: { sources: ['validation'], savedAnalysisRuns: [saved], maxFindings: 128 } }] }));
  const session = createCliFlowSession(model, []);
  const base = headlessFeatures();
  const features = { ...base, backend: new Set([...base.backend, 'review']) };
  const result = await runFlow(graph, { host: session.host, registry: createStandardRegistry(), features });
  expect(result.ok, JSON.stringify(result.log)).toBe(true);
  const output = result.outputs.get('read')?.get('snapshot');
  if (output?.kind !== 'item' || !record(output.value) || !Array.isArray(output.value.findings)) throw new Error('Actual CLI Flow projection missing');
  const snapshot = output.value;
  const findings = snapshot.findings;
  if (!Array.isArray(findings)) throw new Error('Actual imported rows missing');
  const guids = findings.flatMap(finding => record(finding) && Array.isArray(finding.elements)
    ? finding.elements.flatMap(element => record(element) && typeof element.globalId === 'string' ? [element.globalId] : []) : []);
  expect(guids.sort()).toEqual(failures.map(entity => entity.globalId).sort());
  expect(snapshot.origin).toBe('imported');
  expect(snapshot.provenance).toEqual([]);
  expect(Array.isArray(snapshot.records) && snapshot.records.length).toBe(1);
  expect(Array.isArray(snapshot.bindings) && record(snapshot.bindings[0]) && snapshot.bindings[0].state).toBe('bound');
  expect(record(snapshot.bounds) && snapshot.bounds.nativeCoverageComplete).toBe(false);
  expect(session.active()).toBe(model);
  expect(model.backend.getMutationView()).toBeNull();
  expect(createHash('sha256').update(model.store.source.materialize()).digest('hex')).toBe(hash);
  const review = session.host.review;
  if (!review) throw new Error('Actual CLI Review provider required');
  // A provider may throw before returning a promise; observe both refusal forms.
  await expect(Promise.resolve().then(async () => { await review.snapshot({}); })).rejects.toThrow('native session captures are unavailable');
}, 30_000);
