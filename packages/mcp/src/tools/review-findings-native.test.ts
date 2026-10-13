/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { MCPServer, InProcessTransport, InMemoryModelRegistry, buildDefaultToolRegistry,
  ResourceRegistry, PromptRegistry, PROTOCOL_VERSION, fullScope, loadIfcModel,
  type CallToolResult, type JsonRpcMessage } from '../index.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
function result(message: JsonRpcMessage | null): CallToolResult {
  expect(message && 'result' in message).toBeTruthy();
  if (!message || !('result' in message)) throw new Error('Actual MCP dispatch did not return a result');
  return message.result as CallToolResult;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
for (const count of [1, 2]) {
  const caseId = `mcp:models:${count}`;
  const caseTitle = `#7372 actual MCP native IDS result is readable as Review facts for one evaluated model and ${count - 1} unevaluated loaded peers`;
  it(caseTitle, async () => {
  const registry = new InMemoryModelRegistry();
  const model = await loadIfcModel(resolve(root, 'apps/viewer/public/samples/building-architecture.ifc'), { modelId: 'arch' });
  registry.add(model);
  if (count === 2) registry.add(await loadIfcModel(resolve(root, 'apps/viewer/public/samples/building-architecture-rev-b.ifc'), { modelId: 'rev-b' }));
  const bytes = model.store.source.materialize();
  const fullHash = createHash('sha256').update(bytes).digest('hex');
  const originalIds = registry.list().map(item => item.id);
  expect(model.backend.getMutationView()).toBeNull();
  const server = new MCPServer({ version: '7372-source-before', registry, scope: fullScope(),
    config: { readOnly: true, samplingEnabled: false }, tools: buildDefaultToolRegistry(),
    resources: new ResourceRegistry(), prompts: new PromptRegistry() });
  const transport = new InProcessTransport(); await transport.connect(server);
  try {
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: '7372-native-control', version: '1' } } });
    const xml = await readFile(resolve(root, 'apps/viewer/public/samples/building-architecture.ids'), 'utf8');
    const analysis = result(await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'ids_validate', arguments: { model_id: model.id, ids_xml: xml } } }));
    expect(analysis.isError).not.toBe(true);
    const report = analysis.structuredContent?.report;
    expect(record(report)).toBe(true);
    if (!record(report) || !Array.isArray(report.specificationResults)) throw new Error('Actual native IDS report shape unavailable');
    expect(report.specificationResults.length).toBeGreaterThan(0);
    for (const spec of report.specificationResults) {
      expect(record(spec), 'actual native specification result').toBe(true);
      if (!record(spec)) throw new Error('Actual native specification shape unavailable');
      expect(spec.error, 'native specification must not be errored').toBeFalsy();
      expect(spec.setResultsTruncated, 'native set coverage must not be truncated').not.toBe(true);
      expect(Array.isArray(spec.entityResults), 'native explicit evaluated rows').toBe(true);
      expect(typeof spec.applicableCount, 'native applicable population is known').toBe('number');
      if (!Array.isArray(spec.entityResults) || typeof spec.applicableCount !== 'number') {
        throw new Error('Actual native evaluated/applicable scope unavailable');
      }
      expect(Number.isSafeInteger(spec.applicableCount) && spec.applicableCount >= 0).toBe(true);
      expect(spec.entityResults.length, 'complete scope has one native result per applicable entity').toBe(spec.applicableCount);
      expect(spec.entityResults.every(entity => record(entity) && entity.modelId === model.id &&
        typeof entity.passed === 'boolean' && typeof entity.expressId === 'number')).toBe(true);
      const ids = spec.entityResults.flatMap(entity => record(entity) ? [entity.expressId] : []);
      expect(new Set(ids).size, 'no duplicate native row substitutes for an unevaluated member').toBe(ids.length);
    }
    const failed = report.specificationResults.flatMap(spec => record(spec) && Array.isArray(spec.entityResults)
      ? spec.entityResults.filter(entity => record(entity) && entity.passed === false) : []);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.length, 'bounded complete native fixture must fit the proposed128 finding cap').toBeLessThanOrEqual(128);
    const ownedGuids = failed.flatMap(entity => record(entity) && typeof entity.globalId === 'string' ? [entity.globalId] : []);
    expect(ownedGuids.length).toBeGreaterThan(0);
    // Actual public dispatcher executes a proposed read contract. Baseline
    // Unknown tool is a domain capability refusal, not a missing import/API call.
    console.info('[7372-native-prerequisites-complete]', JSON.stringify({ host: 'mcp', caseId, caseTitle,
      loadedModels: count, evaluatedModels: 1, specifications: report.specificationResults.length,
      failures: failed.length, ownedGuidRows: ownedGuids.length, sourceSHA256: fullHash, maxFindings: 128 }));
    const beforeOwnership = registry.list().map(owned => ({ model: owned, view: owned.backend.getMutationView(),
      hash: createHash('sha256').update(owned.store.source.materialize()).digest('hex') }));
    let review: CallToolResult | null = null;
    let dispatchFailure: { error: unknown } | null = null;
    try {
      review = result(await transport.send({ jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'review_findings', arguments: { sources: ['validation'], model_ids: [model.id], max_findings: 128 } } }));
    } catch (error: unknown) { dispatchFailure = { error }; }
    try {
        expect(registry.list().map(item => item.id)).toEqual(originalIds);
        expect(model.backend.getMutationView()).toBeNull();
        expect(createHash('sha256').update(model.store.source.materialize()).digest('hex')).toBe(fullHash);
        for (const owned of beforeOwnership) {
          expect(registry.list().find(item => item.id === owned.model.id)).toBe(owned.model);
          expect(owned.model.backend.getMutationView()).toBe(owned.view);
          expect(createHash('sha256').update(owned.model.store.source.materialize()).digest('hex')).toBe(owned.hash);
        }
        console.info('[7372-readonly-invariants-complete]', JSON.stringify({ host: 'mcp',
          caseId, caseTitle, loadedModels: count, sourceHashes: beforeOwnership.length }));
      } catch (invariantError: unknown) {
        console.error('[7372-readonly-invariant-violation]', JSON.stringify({ host: 'mcp',
          caseId, caseTitle, loadedModels: count,
          message: invariantError instanceof Error ? invariantError.message.slice(0, 512) : null }));
        if (dispatchFailure) throw new AggregateError([dispatchFailure.error, invariantError], 'Review dispatch and readonly invariants failed');
        throw invariantError;
    }
    if (dispatchFailure) throw dispatchFailure.error;
    if (!review) throw new Error('Actual Review dispatcher returned no result');
    // Actual dispatcher data only: bounded text/error fields, never source bytes or model payload.
    const observed = review.structuredContent;
    const responseDiagnostic = { host: 'mcp', caseId, caseTitle, loadedModels: count, isError: review.isError ?? null,
      code: typeof observed?.code === 'string' ? observed.code.slice(0, 64) : null,
      message: typeof observed?.message === 'string' ? observed.message.slice(0, 512) : null,
      hint: typeof observed?.hint === 'string' ? observed.hint.slice(0, 256) : null,
      content: review.content.slice(0, 2).map(item => item.type === 'text'
        ? { type: item.type, text: item.text.slice(0, 512) } : { type: item.type }),
    };
    console.info('[7372-observed-public-review-response]', JSON.stringify(responseDiagnostic).slice(0, 4096));
    expect(review.isError, 'supported native read must expose the actual retained native report').not.toBe(true);
    const snapshot = review.structuredContent;
    expect(snapshot && Array.isArray(snapshot.findings)).toBe(true);
    if (!snapshot || !Array.isArray(snapshot.findings)) throw new Error('Actual Review response shape unavailable');
    const guids = snapshot.findings.flatMap(finding => record(finding) && Array.isArray(finding.elements)
      ? finding.elements.flatMap(element => record(element) && element.modelId === model.id && typeof element.globalId === 'string' ? [element.globalId] : []) : []);
    expect([...new Set(guids)].sort()).toEqual([...new Set(ownedGuids)].sort());
    expect(Array.isArray(snapshot.provenance)).toBe(true);
    if (!Array.isArray(snapshot.provenance) || snapshot.provenance.length !== 1) throw new Error('Actual producer provenance missing');
    const provenance = snapshot.provenance[0];
    if (!record(provenance) || !Array.isArray(provenance.sources)) throw new Error('Actual native source proof missing');
    expect(provenance.origin).toBe('captured');
    expect(provenance.producer).toBe('ids');
    expect(typeof provenance.runId).toBe('string');
    expect(provenance.sources).toEqual([{ modelId: model.id, sourceSHA256: fullHash, sourceByteLength: bytes.byteLength }]);
    expect(record(snapshot.bounds) && snapshot.bounds.knownFindings).toBe(failed.length);
    expect(record(snapshot.bounds) && snapshot.bounds.omittedFindings).toBe(0);
    expect(record(snapshot.bounds) && snapshot.bounds.presentationComplete).toBe(true);
    const bounded = result(await transport.send({ jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'review_findings', arguments: { sources: ['validation'], max_findings: 0 } } }));
    expect(bounded.isError).not.toBe(true);
    expect(bounded.structuredContent?.findings).toEqual([]);
    const bounds = bounded.structuredContent?.bounds;
    expect(record(bounds) && bounds.knownFindings).toBe(failed.length);
    expect(record(bounds) && bounds.omittedFindings).toBe(failed.length);
    expect(record(bounds) && bounds.presentationComplete).toBe(false);
    expect(bounded.content).toContainEqual({ type: 'text', text:
      `Review: 0 native finding row(s) returned. ${failed.length} retained row(s) omitted.` });
    server.setScope({ scopes: ['read'] });
    const flow = { flowVersion: 1, id: '7372-native-review-read', name: 'Read captured native Review',
      capabilities: ['model.read'], inputs: [], outputs: [{ nodeId: 'review', port: 'snapshot', label: 'Native Review' }],
      edges: [], nodes: [{ id: 'review', type: 'review.snapshot', params: { sources: ['validation'], maxFindings: 128 } }] };
    const projected = result(await transport.send({ jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'propose_flow', arguments: { model_id: model.id, flow } } }));
    expect(projected.isError).not.toBe(true);
    expect(projected.structuredContent?.ok).toBe(true);
    const outputs = projected.structuredContent?.outputs;
    if (!Array.isArray(outputs) || !record(outputs[0]) || !record(outputs[0].data)) throw new Error('Actual Flow native Review output missing');
    expect(outputs[0].data.findings).toEqual(snapshot.findings);
    expect(outputs[0].data.provenance).toEqual(snapshot.provenance);
    expect(outputs[0].data.coverage).toEqual(snapshot.coverage);
    for (const owned of beforeOwnership) {
      expect(owned.model.backend.getMutationView()).toBe(owned.view);
      expect(createHash('sha256').update(owned.model.store.source.materialize()).digest('hex')).toBe(owned.hash);
    }
    const wall = model.bim.query().byType('IfcWall').toArray()[0];
    if (!wall) throw new Error('Real source wall required for mutation revision control');
    const originalName = wall.name;
    // Headless SDK undo is explicitly unsupported; use the real MCP journal undo.
    server.config.readOnly = false; server.setScope(fullScope());
    const edited = result(await transport.send({ jsonrpc: '2.0', id: 50, method: 'tools/call',
      params: { name: 'entity_set_attribute', arguments: { model_id: model.id, express_id: wall.ref.expressId,
        attribute: 'Name', value: 'Native source changed after capture' } } }));
    expect(edited.isError).not.toBe(true);
    expect(model.bim.entity(wall.ref)?.name).toBe('Native source changed after capture');
    const undone = result(await transport.send({ jsonrpc: '2.0', id: 51, method: 'tools/call',
      params: { name: 'mutation_undo', arguments: { model_id: model.id, n: 1 } } }));
    expect(undone.isError).not.toBe(true); expect(undone.structuredContent?.undone).toBe(1);
    server.config.readOnly = true; server.setScope({ scopes: ['read'] });
    expect(model.bim.entity(wall.ref)?.name).toBe(originalName);
    const stale = result(await transport.send({ jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'review_findings', arguments: { sources: ['validation'] } } }));
    if (!Array.isArray(stale.structuredContent?.runs) || !record(stale.structuredContent.runs[0])) throw new Error('Retained native run missing after Undo');
    expect(stale.structuredContent.runs[0].complete).toBe(false);
    expect(stale.structuredContent.runs[0].incomplete).toContainEqual({ code: 'stale' });
    const retained = stale.structuredContent?.findings;
    if (!Array.isArray(retained)) throw new Error('Retained native facts missing');
    const nativeRows = (items: unknown[]) => items.map(item => {
      if (!record(item)) throw new Error('Native finding shape lost');
      return Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'run'));
    });
    expect(nativeRows(retained)).toEqual(nativeRows(snapshot.findings));
    expect(stale.structuredContent?.coverage).toEqual(snapshot.coverage);
    expect(createHash('sha256').update(model.store.source.materialize()).digest('hex')).toBe(fullHash);


  } finally { transport.close(); }
});
}

for (const change of ['edit-undo', 'replace', 'revoke', 'principal'] as const) {
  it(`#7372 original MCP dispatcher revalidates ${change} during real source materialization`, async () => {
    const registry = new InMemoryModelRegistry();
    const path = resolve(root, 'apps/viewer/public/samples/building-architecture.ifc');
    const model = await loadIfcModel(path, { modelId: 'arch' });
    registry.add(model);
    const replacement = change === 'replace' ? await loadIfcModel(path, { modelId: 'arch' }) : null;
    const server = new MCPServer({ version: '7372-await-race', registry, scope: fullScope(),
      config: { readOnly: true, samplingEnabled: false }, tools: buildDefaultToolRegistry(),
      resources: new ResourceRegistry(), prompts: new PromptRegistry() });
    const transport = new InProcessTransport(); await transport.connect(server);
    const source = model.store.source;
    const original = source.withMaterializedAsync.bind(source);
    let release: () => void = () => { /* No pending materialization before the pause is installed. */ };
    try {
      await transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: '7372-await-race', version: '1' } } });
      const xml = await readFile(resolve(root, 'apps/viewer/public/samples/building-architecture.ids'), 'utf8');
      const analysis = result(await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'ids_validate', arguments: { model_id: model.id, ids_xml: xml } } }));
      expect(analysis.isError).not.toBe(true);
      const fresh = result(await transport.send({ jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'review_findings', arguments: { sources: ['validation'] } } }));
      expect(fresh.structuredContent?.findings).not.toEqual([]);
      const freshBounds = fresh.structuredContent?.bounds;
      expect(record(freshBounds) && freshBounds.nativeCoverageComplete).toBe(true);
      let reached: () => void = () => { throw new Error('Real source pause has not been installed'); };
      const entered = new Promise<void>(resolvePause => { reached = resolvePause; });
      const paused = new Promise<void>(resolvePause => { release = resolvePause; });
      // The original method computes the actual SHA from the real IFC bytes.
      // Only its return is delayed; neither its bytes nor result are replaced.
      source.withMaterializedAsync = async <T,>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> => {
        const value = await original(fn);
        reached(); await paused; return value;
      };
      const pending = transport.send({ jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'review_findings', arguments: { sources: ['validation'] } } });
      await entered;
      if (change === 'edit-undo') {
        const wall = model.bim.query().byType('IfcWall').toArray()[0];
        if (!wall) throw new Error('Actual source wall missing');
        const name = wall.name;
        server.config.readOnly = false;
        const edited = result(await transport.send({ jsonrpc: '2.0', id: 50, method: 'tools/call',
          params: { name: 'entity_set_attribute', arguments: { model_id: model.id, express_id: wall.ref.expressId,
            attribute: 'Name', value: 'Edited while actual SHA is pending' } } }));
        expect(edited.isError).not.toBe(true);
        expect(model.bim.entity(wall.ref)?.name).not.toBe(name);
        const undone = result(await transport.send({ jsonrpc: '2.0', id: 51, method: 'tools/call',
          params: { name: 'mutation_undo', arguments: { model_id: model.id, n: 1 } } }));
        expect(undone.isError).not.toBe(true); expect(undone.structuredContent?.undone).toBe(1);
        server.config.readOnly = true;
        expect(model.bim.entity(wall.ref)?.name).toBe(name);
      } else if (replacement) registry.add(replacement);
      else if (change === 'revoke') server.setScope({ scopes: [] });
      else server.setScope({ ...fullScope(), user: 'different-reader-during-hash' });
      release();
      const response = result(await pending);
      expect(response.isError).not.toBe(true);
      const snapshot = response.structuredContent;
      if (change === 'revoke' || change === 'principal') {
        expect(snapshot?.findings).toEqual([]); expect(snapshot?.runs).toEqual([]);
        expect(snapshot?.provenance).toEqual([]); expect(snapshot?.coverage).toEqual([]);
        expect(snapshot?.bounds).toMatchObject({ knownFindings: null, omittedFindings: null });
        const serialized = JSON.stringify(snapshot);
        expect(serialized).not.toContain(model.name);
        const digest = createHash('sha256').update(source.materialize()).digest('hex');
        expect(serialized).not.toContain(digest);
      } else {
        if (!snapshot || !Array.isArray(snapshot.runs) || !record(snapshot.runs[0])) throw new Error('Actual retained native run missing');
        expect(snapshot.runs[0].complete).toBe(false);
        expect(snapshot.runs[0].incomplete).toContainEqual({ code: 'stale' });
        expect(record(snapshot.bounds) && snapshot.bounds.nativeCoverageComplete).toBe(false);
        if (change === 'replace') {
          if (!Array.isArray(snapshot.findings)) throw new Error('Actual native finding missing');
          for (const finding of snapshot.findings) {
            if (!record(finding) || !Array.isArray(finding.elements)) throw new Error('Actual native identity missing');
            for (const element of finding.elements) expect(record(element) && element.nativeUnresolved).toBe('unmatched');
          }
        }
      }
    } finally { release(); source.withMaterializedAsync = original; transport.close(); }
  });
}

it('#7372 actual producer capture refuses ownership revoked during its source proof', async () => {
  const registry = new InMemoryModelRegistry();
  const model = await loadIfcModel(resolve(root, 'apps/viewer/public/samples/building-architecture.ifc'), { modelId: 'arch' });
  registry.add(model);
  const server = new MCPServer({ version: '7372-producer-await', registry, scope: fullScope(),
    config: { readOnly: true, samplingEnabled: false }, tools: buildDefaultToolRegistry(),
    resources: new ResourceRegistry(), prompts: new PromptRegistry() });
  const transport = new InProcessTransport(); await transport.connect(server);
  const source = model.store.source;
  const original = source.withMaterializedAsync.bind(source);
  let release: () => void = () => { /* No pending source proof before installation. */ };
  try {
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: '7372-producer-await', version: '1' } } });
    let reached: () => void = () => { throw new Error('Source pause not installed'); };
    const entered = new Promise<void>(resolvePause => { reached = resolvePause; });
    const paused = new Promise<void>(resolvePause => { release = resolvePause; });
    source.withMaterializedAsync = async <T,>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> => {
      const value = await original(fn); reached(); await paused; return value;
    };
    const xml = await readFile(resolve(root, 'apps/viewer/public/samples/building-architecture.ids'), 'utf8');
    const pending = transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'ids_validate', arguments: { model_id: model.id, ids_xml: xml } } });
    await entered; server.setScope({ scopes: [] }); release();
    const analysis = result(await pending);
    // Existing independent native analysis stays observable; no capture is
    // permitted to claim fresh authorization acquired before the await.
    expect(analysis.isError).not.toBe(true);
    expect(record(analysis.structuredContent?.report)).toBe(true);
    source.withMaterializedAsync = original;
    server.setScope(fullScope());
    const read = result(await transport.send({ jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'review_findings', arguments: { sources: ['validation'] } } }));
    expect(read.structuredContent?.findings).toEqual([]);
    expect(read.structuredContent?.provenance).toEqual([]);
    expect(read.structuredContent?.sources).toContainEqual({ source: 'validation', state: 'unavailable', refusal: 'scope' });
  } finally { release(); source.withMaterializedAsync = original; transport.close(); }
});


it('#7372 actual MCP reads independently evaluated requested contexts without unrelated permitted captures poisoning availability', async () => {
  const registry = new InMemoryModelRegistry();
  for (const modelId of ['arch-a', 'arch-b']) registry.add(await loadIfcModel(
    resolve(root, 'apps/viewer/public/samples/building-architecture.ifc'), { modelId }));
  const models = registry.list(); const before = models.map(model => ({ model,
    hash: createHash('sha256').update(model.store.source.materialize()).digest('hex') }));
  const server = new MCPServer({ version: '7372-selected-context', registry, scope: fullScope(),
    config: { readOnly: true, samplingEnabled: false }, tools: buildDefaultToolRegistry(),
    resources: new ResourceRegistry(), prompts: new PromptRegistry() });
  const transport = new InProcessTransport(); await transport.connect(server);
  try {
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: '7372-selector-control', version: '1' } } });
    const xml = await readFile(resolve(root, 'apps/viewer/public/samples/building-architecture.ids'), 'utf8');
    const counts = new Map<string, number>();
    for (const [index, model] of models.entries()) {
      const analysis = result(await transport.send({ jsonrpc: '2.0', id: 2 + index, method: 'tools/call',
        params: { name: 'ids_validate', arguments: { model_id: model.id, ids_xml: xml } } }));
      expect(analysis.isError).not.toBe(true);
      const report = analysis.structuredContent?.report;
      if (!record(report) || !Array.isArray(report.specificationResults)) throw new Error('Actual independent native report missing');
      const rows = report.specificationResults.flatMap(spec => {
        if (!record(spec) || !Array.isArray(spec.entityResults)) throw new Error('Actual native evaluated rows missing');
        expect(spec.error).toBeFalsy(); return spec.entityResults.filter(row => record(row) && row.passed === false);
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(row => record(row) && row.modelId === model.id)).toBe(true);
      counts.set(model.id, rows.length);
    }
    for (const [index, model] of models.entries()) {
      const selected = result(await transport.send({ jsonrpc: '2.0', id: 10 + index, method: 'tools/call',
        params: { name: 'review_findings', arguments: { sources: ['validation'], model_ids: [model.id] } } }));
      expect(selected.isError).not.toBe(true);
      const snapshot = selected.structuredContent;
      if (!snapshot || !Array.isArray(snapshot.findings) || !Array.isArray(snapshot.provenance)) throw new Error('Actual selected Review facts missing');
      expect(snapshot.sources).toEqual([{ source: 'validation', state: 'available' }]);
      expect(snapshot.findings.length).toBe(counts.get(model.id)); expect(snapshot.provenance).toHaveLength(1);
      expect(snapshot.provenance[0]).toMatchObject({ sources: [{ modelId: model.id, sourceSHA256: before[index].hash }] });
      expect(snapshot.bounds).toMatchObject({ knownFindings: counts.get(model.id), nativeCoverageComplete: true });
      if (index === 0) expect(snapshot.latestAttempt).toBeNull();
    }
    server.setScope({ scopes: ['read'], modelIds: [models[0].id] });
    const revoked = result(await transport.send({ jsonrpc: '2.0', id: 20, method: 'tools/call',
      params: { name: 'review_findings', arguments: { sources: ['validation'], model_ids: [models[0].id] } } }));
    expect(revoked.structuredContent?.sources).toEqual([{ source: 'validation', state: 'unavailable', refusal: 'scope' }]);
    expect(revoked.structuredContent?.bounds).toMatchObject({ knownFindings: null, nativeCoverageComplete: false });
    for (const owned of before) {
      expect(owned.model.backend.getMutationView()).toBeNull();
      expect(createHash('sha256').update(owned.model.store.source.materialize()).digest('hex')).toBe(owned.hash);
    }
  } finally { transport.close(); }
});
