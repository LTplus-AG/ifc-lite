/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { MCPServer, InProcessTransport, InMemoryModelRegistry, buildDefaultToolRegistry,
  ResourceRegistry, PromptRegistry, PROTOCOL_VERSION, fullScope, loadIfcModel,
  type CallToolResult, type JsonRpcMessage } from '../index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const sample = resolve(root, 'apps/viewer/public/samples/building-architecture.ifc');
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function response(message: JsonRpcMessage | null): CallToolResult {
  if (!message || !('result' in message)) throw new Error('Actual MCP dispatcher returned no result');
  return message.result as CallToolResult;
}
async function connect(registry: InMemoryModelRegistry) {
  const server = new MCPServer({ version: '7372-portable-control', registry, scope: fullScope(),
    config: { readOnly: true, samplingEnabled: false }, tools: buildDefaultToolRegistry(),
    resources: new ResourceRegistry(), prompts: new PromptRegistry() });
  const transport = new InProcessTransport();
  await transport.connect(server);
  await transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: '7372-portable', version: '1' } } });
  let next = 2;
  return { server, transport, call: async (name: string, args: Record<string, unknown>) => response(await transport.send({
    jsonrpc: '2.0', id: next++, method: 'tools/call', params: { name, arguments: args } })) };
}

for (const count of [1, 2]) {
  it(`#7372 saved actual IDS facts survive JSON reload with ${count} MCP models and Flow parity without reanalysis`, async () => {
    const originalRegistry = new InMemoryModelRegistry();
    const original = await loadIfcModel(sample, { modelId: 'original-session' });
    originalRegistry.add(original);
    const first = await connect(originalRegistry);
    let saved: unknown;
    let originalGuids: string[] = [];
    const hash = createHash('sha256').update(original.store.source.materialize()).digest('hex');
    try {
      const xml = await readFile(resolve(root, 'apps/viewer/public/samples/building-architecture.ids'), 'utf8');
      const analyzed = await first.call('ids_validate', { model_id: original.id, ids_xml: xml });
      expect(analyzed.isError).not.toBe(true);
      const report = analyzed.structuredContent?.report;
      if (!record(report) || !Array.isArray(report.specificationResults)) throw new Error('Actual native IDS report required');
      const failures = report.specificationResults.flatMap(spec => {
        if (!record(spec) || !Array.isArray(spec.entityResults)) throw new Error('Actual native entity rows required');
        expect(spec.error).toBeFalsy();
        expect(spec.setResultsTruncated).not.toBe(true);
        expect(spec.entityResults.length).toBe(spec.applicableCount);
        return spec.entityResults.filter(entity => record(entity) && entity.passed === false);
      });
      expect(failures.length).toBeGreaterThan(0);
      originalGuids = failures.flatMap(entity => record(entity) && typeof entity.globalId === 'string' ? [entity.globalId] : []);
      expect(originalGuids.length).toBe(failures.length);
      const captured = await first.call('review_findings', { sources: ['validation'] });
      const provenance = captured.structuredContent?.provenance;
      if (!Array.isArray(provenance) || !record(provenance[0])) throw new Error('Actual native capture provenance required');
      if (typeof provenance[0].capturedAt !== 'string') throw new Error('Actual capture time required');
      const stamp = provenance[0].capturedAt;
      // Existing SavedAnalysisRun compatibility wire: actual native report and
      // source proof, serialized exactly as a saved document would serialize it.
      saved = JSON.parse(JSON.stringify({ version: 1, id: provenance[0].runId,
        capturedAt: stamp, savedAt: stamp, models: [{ key: original.id, name: original.name, sourceContentHash: hash }],
        examined: [original.id], freshness: 'current', edited: false, placementRecorded: false, frame: null,
        kind: 'validation', report, ruleSet: null }));
      expect(original.backend.getMutationView()).toBeNull();
    } finally { first.transport.close(); }

    // A new registry/server owns a newly parsed model with a different runtime
    // id. It has never called a producer; the supplied wire is its only evidence.
    const registry = new InMemoryModelRegistry();
    const reloaded = await loadIfcModel(sample, { modelId: 'reloaded-session' });
    registry.add(reloaded);
    if (count === 2) registry.add(await loadIfcModel(resolve(root,
      'apps/viewer/public/samples/building-architecture-rev-b.ifc'), { modelId: 'unevaluated-peer' }));
    const second = await connect(registry);
    const before = registry.list().map(model => ({ model, hash: createHash('sha256').update(model.store.source.materialize()).digest('hex') }));
    try {
      second.server.setScope({ scopes: ['read'] });
      const emptyNative = await second.call('review_findings', { sources: ['validation'] });
      expect(emptyNative.structuredContent?.findings).toEqual([]);
      const imported = await second.call('review_findings', { sources: ['validation'], model_ids: [reloaded.id],
        saved_analysis_runs: [saved], max_findings: 128 });
      expect(imported.isError).not.toBe(true);
      const snapshot = imported.structuredContent;
      if (!snapshot || !Array.isArray(snapshot.findings) || !Array.isArray(snapshot.provenance)) throw new Error('Portable Review envelope missing');
      const guids = snapshot.findings.flatMap(finding => record(finding) && Array.isArray(finding.elements)
        ? finding.elements.flatMap(element => record(element) && typeof element.globalId === 'string' ? [element.globalId] : []) : []);
      expect(guids.sort()).toEqual(originalGuids.sort());
      expect(snapshot.origin).toBe('imported');
      expect(snapshot.provenance).toEqual([]);
      expect(Array.isArray(snapshot.records) && snapshot.records.length).toBe(1);
      expect(Array.isArray(snapshot.bindings) && record(snapshot.bindings[0]) && snapshot.bindings[0].state).toBe('bound');
      expect(record(snapshot.bounds) && snapshot.bounds.nativeCoverageComplete).toBe(false);
      expect(Array.isArray(snapshot.runs) && snapshot.runs.every(run => record(run) && run.complete === false)).toBe(true);
      const flow = { flowVersion: 1, id: '7372-import-read', name: 'Read saved evidence', capabilities: ['model.read'], inputs: [],
        outputs: [{ nodeId: 'review', port: 'snapshot', label: 'Historical Review' }], edges: [],
        nodes: [{ id: 'review', type: 'review.snapshot', params: { sources: ['validation'], modelIds: [reloaded.id], savedAnalysisRuns: [saved], maxFindings: 128 } }] };
      const projected = await second.call('propose_flow', { model_id: reloaded.id, flow });
      expect(projected.isError).not.toBe(true);
      expect(projected.structuredContent?.ok).toBe(true);
      const outputs = projected.structuredContent?.outputs;
      if (!Array.isArray(outputs) || !record(outputs[0]) || !record(outputs[0].data)) throw new Error('Actual Flow imported projection missing');
      expect(outputs[0].data).toEqual(snapshot);
      expect((await second.call('review_findings', { sources: ['validation'] })).structuredContent?.findings).toEqual([]);
      for (const owned of before) {
        expect(registry.list().find(model => model.id === owned.model.id)).toBe(owned.model);
        expect(owned.model.backend.getMutationView()).toBeNull();
        expect(createHash('sha256').update(owned.model.store.source.materialize()).digest('hex')).toBe(owned.hash);
      }
      second.server.setScope({ scopes: ['read'], modelIds: ['not-the-reloaded-owner'] });
      const denied = await second.call('review_findings', { saved_analysis_runs: [saved], model_ids: [reloaded.id] });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent?.findings).toBeUndefined();
    } finally { second.transport.close(); }
  }, 30_000);
}
