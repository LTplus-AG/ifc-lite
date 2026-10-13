/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { Rule, type RuleSetFile } from '@ifc-lite/rules';
import { MCPServer, InProcessTransport, InMemoryModelRegistry, buildDefaultToolRegistry,
  ResourceRegistry, PromptRegistry, PROTOCOL_VERSION, fullScope, loadIfcModel,
  type CallToolResult, type JsonRpcMessage } from '../index.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function result(message: JsonRpcMessage | null): CallToolResult {
  if (!message || !('result' in message)) throw new Error('Actual MCP dispatch did not return a result');
  return message.result as CallToolResult;
}
async function realHost() {
  const registry = new InMemoryModelRegistry();
  const model = await loadIfcModel(resolve(root, 'apps/viewer/public/samples/building-architecture.ifc'), { modelId: 'arch-boundary' });
  registry.add(model);
  const hash = createHash('sha256').update(model.store.source.materialize()).digest('hex');
  const xml = await readFile(resolve(root, 'apps/viewer/public/samples/building-architecture.ids'), 'utf8');
  expect(xml).toContain('<title>Building Architecture IDS</title>');
  const server = new MCPServer({ version: '7372-native-boundaries', registry, scope: fullScope(),
    config: { readOnly: false, samplingEnabled: false }, tools: buildDefaultToolRegistry(),
    resources: new ResourceRegistry(), prompts: new PromptRegistry() });
  const transport = new InProcessTransport(); await transport.connect(server);
  let sequence = 1;
  await transport.send({ jsonrpc: '2.0', id: sequence, method: 'initialize', params: {
    protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: '7372-real-native-boundaries', version: '1' } } });
  const call = async (name: string, args: Record<string, unknown>) => result(await transport.send({
    jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args } }));
  const title = (value: string) => xml.replace('<title>Building Architecture IDS</title>', `<title>${value}</title>`);
  const read = () => call('review_findings', { sources: ['validation'], max_findings: 512 });
  const flow = (key: string, validate: boolean) => call('run_flow', { model_id: model.id, flow: {
    flowVersion: 1, id: '7372-real-secret-enrollment', name: 'Authorized native secret boundary',
    capabilities: ['model.read', `secret.read:${key}`], inputs: [],
    outputs: [{ nodeId: validate ? 'validate' : 'load', port: validate ? 'report' : 'title', label: 'Actual native output' }],
    nodes: [{ id: 'load', type: 'ids.load', params: { xml: title(`{{secret:${key}}}`) } },
      ...(validate ? [{ id: 'validate', type: 'ids.validate' }] : [])],
    edges: validate ? [{ from: ['load', 'ids'], to: ['validate', 'ids'] }] : [],
  } });
  const unchanged = () => {
    expect(registry.list()).toEqual([model]); expect(model.backend.getMutationView()).toBeNull();
    expect(createHash('sha256').update(model.store.source.materialize()).digest('hex')).toBe(hash);
  };
  return { registry, model, server, transport, xml, title, call, read, flow, unchanged };
}
function failures(analysis: CallToolResult): number {
  expect(analysis.isError).not.toBe(true);
  const report = analysis.structuredContent?.report;
  if (!record(report) || !Array.isArray(report.specificationResults)) throw new Error('Actual native IDS report missing');
  expect(report.specificationResults.length).toBeGreaterThan(0);
  const failed = report.specificationResults.flatMap(spec => record(spec) && Array.isArray(spec.entityResults)
    ? spec.entityResults.filter(row => record(row) && row.passed === false) : []);
  expect(failed.length).toBeGreaterThan(0);
  return failed.length;
}
function withheld(read: CallToolResult, refusal: string) {
  expect(read.isError).not.toBe(true);
  for (const key of ['findings', 'runs', 'provenance', 'coverage']) expect(read.structuredContent?.[key]).toEqual([]);
  expect(read.structuredContent?.sources).toEqual([{ source: 'validation', state: 'unavailable', refusal }]);
  expect(read.structuredContent?.bounds).toMatchObject({ knownFindings: null, omittedFindings: null,
    nativeCoverageComplete: false, presentationComplete: false });
}

// #7372: the existing SDK zero-capacity guard is a stateless permanent refusal,
// not a missing producer. Owner overflow must not disclose an earlier owner's facts.
it('#7372 a 33rd distinct owner keeps an explicit refusal across independent calls without affecting retained owners', async () => {
  const host = await realHost();
  let fresh: Awaited<ReturnType<typeof realHost>> | undefined;
  try {
    host.server.setScope({ ...fullScope(), user: '7372-owner-bound-0' });
    const nativeFailures = failures(await host.call('ids_validate', { model_id: host.model.id, ids_xml: host.xml }));
    const retained = await host.read();
    expect(Array.isArray(retained.structuredContent?.findings) && retained.structuredContent.findings.length).toBe(nativeFailures);
    // Allocate the remaining admitted identities through the real public reader;
    // none may inherit the first owner's genuinely evaluated native evidence.
    for (let index = 1; index < 32; index++) {
      host.server.setScope({ ...fullScope(), user: `7372-owner-bound-${index}` });
      const empty = await host.read();
      expect(empty.structuredContent?.sources).toEqual([{ source: 'validation', state: 'not-run' }]);
      expect(empty.structuredContent?.findings).toEqual([]);
    }
    host.server.setScope({ ...fullScope(), user: '7372-owner-bound-32' });
    // Native validation still runs and supplies actual IFC results; only capture
    // capacity is refused, including on the next independently dispatched read.
    expect(failures(await host.call('ids_validate', { model_id: host.model.id, ids_xml: host.xml }))).toBe(nativeFailures);
    withheld(await host.read(), 'work-bound');
    withheld(await host.read(), 'work-bound');
    host.server.setScope({ ...fullScope(), user: '7372-owner-bound-33' });
    withheld(await host.read(), 'work-bound');
    host.server.setScope({ ...fullScope(), user: '7372-owner-bound-0' });
    expect((await host.read()).structuredContent).toEqual(retained.structuredContent);
    host.unchanged();
    // A new registry/session admits the same overflow principal independently;
    // the bound is neither an unbounded identity cache nor a global deny latch.
    fresh = await realHost();
    fresh.server.setScope({ ...fullScope(), user: '7372-owner-bound-32' });
    expect(failures(await fresh.call('ids_validate', { model_id: fresh.model.id, ids_xml: fresh.xml }))).toBe(nativeFailures);
    const admitted = await fresh.read();
    expect(Array.isArray(admitted.structuredContent?.findings) && admitted.structuredContent.findings.length).toBe(nativeFailures);
    fresh.unchanged();
  } finally {
    await host.transport.close();
    if (fresh) await fresh.transport.close();
  }
});

// Original public dispatcher and actual IDS engine: no provider return is mocked.
it('#7372 Flow enrollment prevents older native title evidence leaking into an independent Review read', async () => {
  const host = await realHost();
  const key = 'IFC_LITE_REVIEW_CREDENTIAL_BOUNDARY_7372';
  const secret = 'native-review-credential-7372-unique';
  const previous = process.env[key]; process.env[key] = secret;
  try {
    const earlier = await host.call('ids_validate', { model_id: host.model.id, ids_xml: host.title(secret) });
    const nativeFailures = failures(earlier);
    const control = await host.read();
    expect(Array.isArray(control.structuredContent?.findings) && control.structuredContent.findings.length).toBe(nativeFailures);
    expect(JSON.stringify(control)).toContain(secret); // Not yet enrolled as a credential by this owner.
    const flow = await host.flow(key, true);
    expect(flow.isError).not.toBe(true); expect(flow.structuredContent?.ok).toBe(true);
    const outputs = flow.structuredContent?.outputs;
    if (!Array.isArray(outputs) || !record(outputs[0]) || !record(outputs[0].data)) throw new Error('Actual native Flow report missing');
    expect(failures({ content: [], structuredContent: { report: outputs[0].data } })).toBe(nativeFailures);
    expect(JSON.stringify(flow)).toContain(`<secret:${key}>`); expect(JSON.stringify(flow)).not.toContain(secret);
    host.server.setScope({ scopes: ['read'] });
    const review = await host.read(); withheld(review, 'sensitive-input');
    expect(JSON.stringify(review)).not.toContain(secret);
    // Credential capacity fails this owner permanently closed and retains old
    // enrollment even when a later graph has no previously secret native title.
    host.server.setScope(fullScope()); process.env[key] = 'x'.repeat(16_385);
    const oversized = await host.flow(key, false);
    expect(oversized.isError).not.toBe(true); expect(oversized.structuredContent?.ok).toBe(true);
    expect(JSON.stringify(oversized)).not.toContain(process.env[key]);
    const bounded = await host.read(); withheld(bounded, 'work-bound');
    delete process.env[key];
    withheld(await host.read(), 'work-bound'); host.unchanged();
  } finally { await host.transport.close(); if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
});

it('#7372 SDK final envelope refuses credentials enrolled while genuine source SHA is awaiting return', async () => {
  const host = await realHost();
  const key = 'IFC_LITE_REVIEW_DURING_HASH_7372';
  const secret = 'native"review\\during-hash-7372';
  const previous = process.env[key]; process.env[key] = secret;
  const source = host.model.store.source;
  const original = source.withMaterializedAsync.bind(source);
  let release: () => void = () => { /* No materialization is pending before barrier installation. */ };
  try {
    failures(await host.call('ids_validate', { model_id: host.model.id, ids_xml: host.title(secret) }));
    const before = await host.read();
    const runs = before.structuredContent?.runs;
    expect(Array.isArray(runs) && record(runs[0]) && runs[0].label).toBe(secret);
    let entered: () => void = () => { throw new Error('Real source barrier not installed'); };
    const reached = new Promise<void>(resolveReached => { entered = resolveReached; });
    const pause = new Promise<void>(resolvePause => { release = resolvePause; });
    source.withMaterializedAsync = async <T,>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> => {
      const actual = await original(fn); entered(); await pause; return actual;
    };
    const pending = host.read(); await reached;
    // A real authorized Flow load enrolls its known values. It has no capture
    // start of its own, so only the in-flight reader's final check can close it.
    const enrollment = await host.flow(key, false);
    expect(enrollment.isError).not.toBe(true); expect(enrollment.structuredContent?.ok).toBe(true);
    expect(JSON.stringify(enrollment)).not.toContain(JSON.stringify(secret).slice(1, -1));
    release(); const read = await pending; withheld(read, 'sensitive-input');
    expect(JSON.stringify(read)).not.toContain(JSON.stringify(secret).slice(1, -1)); host.unchanged();
  } finally { release(); source.withMaterializedAsync = original; await host.transport.close();
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
});

it('#7372 32 pending native reservations refuse a 33rd before hashing and recover on a later real analysis', async () => {
  const host = await realHost();
  const controlFailures = failures(await host.call('ids_validate', { model_id: host.model.id, ids_xml: host.xml }));
  host.server.setScope({ ...fullScope(), user: '7372-concurrent-native-owner' });
  const source = host.model.store.source;
  const original = source.withMaterializedAsync.bind(source);
  const releases: Array<() => void> = [];
  const gates = Array.from({ length: 32 }, () => new Promise<void>(resolveGate => { releases.push(resolveGate); }));
  let reached: () => void = () => { throw new Error('Real concurrent source barrier not installed'); };
  const allReached = new Promise<void>(resolveReached => { reached = resolveReached; });
  let started = 0, hashed = 0;
  const pending: Array<Promise<CallToolResult>> = [];
  try {
    source.withMaterializedAsync = async <T,>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> => {
      const index = started++;
      const actual = await original(fn);
      if (index < 32) { if (++hashed === 32) reached(); await gates[index]; }
      return actual;
    };
    for (let index = 0; index < 32; index++) pending.push(host.call('ids_validate', {
      model_id: host.model.id, ids_xml: host.title(`Concurrent native context ${index}`) }));
    await allReached; expect(hashed).toBe(32);
    // This native analysis still runs, but the full capture reservation bound
    // refuses its proof work before entering the materialization barrier.
    const excess = await host.call('ids_validate', { model_id: host.model.id, ids_xml: host.title('Excess native context') });
    expect(failures(excess)).toBe(controlFailures); expect(started).toBe(32);
    for (const release of releases) release();
    for (const report of await Promise.all(pending)) expect(failures(report)).toBe(controlFailures);
    const bounded = await host.read();
    expect(bounded.isError).not.toBe(true);
    expect(Array.isArray(bounded.structuredContent?.runs) && bounded.structuredContent.runs.length).toBe(32);
    expect(Array.isArray(bounded.structuredContent?.findings) && bounded.structuredContent.findings.length).toBe(32 * controlFailures);
    const provenance = bounded.structuredContent?.provenance;
    if (!Array.isArray(provenance)) throw new Error('Admitted native producer provenance missing');
    expect(new Set(provenance.map(item => record(item) ? item.runId : null)).size).toBe(32);
    expect(bounded.structuredContent?.sources).toEqual([{ source: 'validation', state: 'unavailable', refusal: 'work-bound' }]);
    expect(bounded.structuredContent?.bounds).toMatchObject({ knownFindings: null, omittedFindings: null, nativeCoverageComplete: false });
    expect(failures(await host.call('ids_validate', { model_id: host.model.id,
      ids_xml: host.title('Concurrent native context 0') }))).toBe(controlFailures);
    const recovered = await host.read();
    expect(recovered.structuredContent?.bounds).toMatchObject({ knownFindings: 32 * controlFailures, nativeCoverageComplete: true });
    expect(recovered.structuredContent?.retention).toMatchObject({ inventoryOmitted: false });
    host.unchanged();
  } finally { for (const release of releases) release(); await Promise.allSettled(pending);
    source.withMaterializedAsync = original; await host.transport.close(); }
}, 30_000);

it('#7372 sequential genuine native reruns replace the same context and disclose distinct history eviction', async () => {
  const host = await realHost();
  try {
    const ids = new Set<string>();
    let count = 0;
    for (let index = 0; index < 33; index++) {
      count = failures(await host.call('ids_validate', { model_id: host.model.id, ids_xml: host.xml }));
      const read = await host.read();
      expect(read.structuredContent?.bounds).toMatchObject({ knownFindings: count, nativeCoverageComplete: true });
      const proof = read.structuredContent?.provenance;
      if (!Array.isArray(proof) || proof.length !== 1 || !record(proof[0]) || typeof proof[0].runId !== 'string') {
        throw new Error('Latest successful native context must retain exactly one genuine run');
      }
      expect(ids.has(proof[0].runId)).toBe(false); ids.add(proof[0].runId);
      expect(read.structuredContent?.latestAttempt).toMatchObject({ state: 'succeeded', proof: proof[0] });
    }
    host.server.setScope({ ...fullScope(), user: '7372-distinct-native-history' });
    for (let index = 0; index < 33; index++) expect(failures(await host.call('ids_validate', {
      model_id: host.model.id, ids_xml: host.title(`Distinct historical definition ${index}`) }))).toBe(count);
    const retained = await host.read();
    const runs = retained.structuredContent?.runs;
    if (!Array.isArray(runs)) throw new Error('Retained native runs missing');
    expect(runs).toHaveLength(32);
    expect(runs.map(run => record(run) ? run.label : null)).toEqual(Array.from({ length: 32 }, (_, i) => `Distinct historical definition ${i + 1}`));
    expect(retained.structuredContent?.retention).toEqual({ policy: 'latest-successful-native-context', limit: 32,
      inventoryOmitted: true, omittedHistoricalRuns: null, captureRefusal: null });
    expect(retained.structuredContent?.bounds).toMatchObject({ knownFindings: count * 32,
      knownFindingsScope: 'retained-current-contexts', nativeCoverageComplete: false });
    host.unchanged();
  } finally { await host.transport.close(); }
}, 30_000);

it('#7372 direct SDK native envelope refuses enrollment during its genuine source hash without a host projection guard', async () => {
  const host = await realHost();
  const { NativeReviewCaptures } = await import('@ifc-lite/sdk/review');
  const { parseIDS, validateIDS } = await import('@ifc-lite/ids');
  const { createDataAccessor } = await import('@ifc-lite/ids/bridge');
  const secret = 'native-sdk"credential\\during-hash-7372';
  const xml = host.title(` ${secret} `);
  const model = host.model;
  const report = await validateIDS(parseIDS(xml), createDataAccessor(model.store), {
    modelId: model.id, schemaVersion: model.store.schemaVersion, entityCount: model.store.entityCount,
  });
  const nativeFailures = report.specificationResults.flatMap(spec => spec.entityResults.filter(row => !row.passed)).length;
  expect(nativeFailures).toBeGreaterThan(0);
  const models = () => [{ id: model.id, name: model.name, owner: model, store: model.store, source: model.store.source,
    mutationView: () => model.backend.getMutationView(),
    expressIdOf: (GlobalId: string) => model.store.entities.getExpressIdByGlobalId(GlobalId),
    globalIdOf: (expressId: number) => model.bim.entity({ modelId: model.id, expressId })?.globalId ?? '' }];
  const allowed = (id: string) => id === model.id;
  const captures = new NativeReviewCaptures();
  const token = await captures.begin('ids', xml, models(), models, allowed);
  expect(token).not.toBeNull(); captures.finish(token, report);
  const control = await captures.read(models, allowed, value => value);
  expect(control.findings).toHaveLength(nativeFailures); expect(control.availability).toBe('available');
  expect(control.runs[0].label).toBe(secret);
  const source = model.store.source;
  const original = source.withMaterializedAsync.bind(source);
  let release: () => void = () => { /* No source operation is pending before installation. */ };
  try {
    let entered: () => void = () => { throw new Error('Real SDK source barrier not installed'); };
    const reached = new Promise<void>(resolveReached => { entered = resolveReached; });
    const pause = new Promise<void>(resolvePause => { release = resolvePause; });
    source.withMaterializedAsync = async <T,>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> => {
      const actual = await original(fn); entered(); await pause; return actual;
    };
    const pending = captures.read(models, allowed, value => value);
    // This exact known padded value is normalized by the real IDS parser.
    await reached; captures.enrollCredentials([` ${secret} `]); release();
    const read = await pending;
    expect(read.availability).toBe('unavailable'); expect(read.refusal).toBe('sensitive-input');
    expect(read.findings).toEqual([]); expect(read.runs).toEqual([]);
    expect(read.provenance).toEqual([]); expect(read.coverage).toEqual([]);
    expect(JSON.stringify(read)).not.toContain(JSON.stringify(secret).slice(1, -1));
    // Repeated values also have a finite enrollment input-work bound; they
    // cannot evade it by occupying only one distinct credential slot.
    captures.enrollCredentials(Array.from({ length: 257 }, () => secret));
    const bounded = await captures.read(models, allowed, value => value);
    expect(bounded.refusal).toBe('work-bound'); expect(bounded.provenance).toEqual([]);
    host.unchanged();
  } finally { release(); source.withMaterializedAsync = original; await host.transport.close(); }
});

it('#7372 an older proof and genuine native success cannot erase a newer capture refusal', async () => {
  const host = await realHost();
  const source = host.model.store.source;
  const original = source.withMaterializedAsync.bind(source);
  let release: () => void = () => { /* No proof is awaiting the barrier yet. */ };
  let older: Promise<CallToolResult> | undefined;
  try {
    let entered: () => void = () => { throw new Error('Actual source barrier not installed'); };
    const reached = new Promise<void>(resolveReached => { entered = resolveReached; });
    const pause = new Promise<void>(resolvePause => { release = resolvePause; });
    let calls = 0;
    source.withMaterializedAsync = async <T,>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> => {
      const index = calls++;
      const actual = await original(fn);
      if (index === 0) { entered(); await pause; }
      if (index === 1) throw new Error('Controlled source materialization refusal');
      return actual;
    };
    older = host.call('ids_validate', { model_id: host.model.id, ids_xml: host.xml });
    await reached;
    const newer = await host.call('ids_validate', { model_id: host.model.id, ids_xml: host.xml });
    const count = failures(newer);
    release(); expect(failures(await older)).toBe(count);
    const retained = await host.read();
    expect(retained.structuredContent?.sources).toEqual([{ source: 'validation', state: 'unavailable', refusal: 'source-unavailable' }]);
    expect(retained.structuredContent?.latestAttempt).toEqual({ state: 'refused', refusal: 'source-unavailable', proof: null });
    expect(retained.structuredContent?.bounds).toMatchObject({ knownFindings: null, nativeCoverageComplete: false });
    const proof = retained.structuredContent?.provenance;
    if (!Array.isArray(proof) || proof.length !== 1 || !record(proof[0])) throw new Error('Earlier actual native evidence missing');
    const olderId = proof[0].runId;
    expect(failures(await host.call('ids_validate', { model_id: host.model.id, ids_xml: host.xml }))).toBe(count);
    const recovered = await host.read();
    expect(recovered.structuredContent?.bounds).toMatchObject({ knownFindings: count, nativeCoverageComplete: true });
    const newerProof = recovered.structuredContent?.provenance;
    if (!Array.isArray(newerProof) || newerProof.length !== 1 || !record(newerProof[0])) throw new Error('Recovery native evidence missing');
    expect(newerProof[0].runId).not.toBe(olderId); host.unchanged();
  } finally { release(); if (older) await Promise.allSettled([older]);
    source.withMaterializedAsync = original; await host.transport.close(); }
});

it('#7372 an actual native producer error abandons admission and preserves earlier evidence as historical', async () => {
  const host = await realHost();
  try {
    const count = failures(await host.call('ids_validate', { model_id: host.model.id, ids_xml: host.xml }));
    const control = await host.read();
    let failProgress = true;
    let nativeProgress = 0;
    host.server.attach({ send(message) {
      if ('method' in message && message.method === 'notifications/progress') {
        nativeProgress++;
        if (failProgress) throw new Error('Controlled native producer progress failure');
      }
    } });
    const failed = result(await host.transport.send({ jsonrpc: '2.0', id: 7372001, method: 'tools/call',
      params: { name: 'ids_validate', arguments: { model_id: host.model.id, ids_xml: host.xml },
        _meta: { progressToken: '7372-real-producer-error' } } }));
    expect(failed.isError).toBe(true); expect(nativeProgress).toBeGreaterThan(0);
    const historical = await host.read();
    expect(historical.structuredContent?.provenance).toEqual(control.structuredContent?.provenance);
    expect(historical.structuredContent?.coverage).toEqual(control.structuredContent?.coverage);
    const runs = historical.structuredContent?.runs;
    if (!Array.isArray(runs) || !record(runs[0])) throw new Error('Earlier native report must remain available as historical evidence');
    expect(runs[0]).toMatchObject({ temporal: 'historical', complete: false });
    expect(historical.structuredContent?.latestAttempt).toMatchObject({ state: 'failed', refusal: 'producer-failed' });
    expect(historical.structuredContent?.bounds).toMatchObject({ knownFindings: null, nativeCoverageComplete: false });
    // More than the pending bound of actual failures must still permit a later
    // genuine success. No capture state is constructed or read directly.
    for (let i = 0; i < 33; i++) {
      const reply = result(await host.transport.send({ jsonrpc: '2.0', id: 7372010 + i, method: 'tools/call',
        params: { name: 'ids_validate', arguments: { model_id: host.model.id, ids_xml: host.xml },
          _meta: { progressToken: `7372-failure-${i}` } } }));
      expect(reply.isError).toBe(true);
      expect((await host.read()).structuredContent?.latestAttempt).toMatchObject({ state: 'failed', refusal: 'producer-failed' });
    }
    failProgress = false;
    expect(failures(await host.call('ids_validate', { model_id: host.model.id, ids_xml: host.xml }))).toBe(count);
    const recovered = await host.read();
    expect(recovered.structuredContent?.bounds).toMatchObject({ knownFindings: count, nativeCoverageComplete: true });
    expect(recovered.structuredContent?.latestAttempt).toMatchObject({ state: 'succeeded' }); host.unchanged();
  } finally { await host.transport.close(); }
}, 30_000);

it('#7372 actual protocol cancellation releases proof admission and a later genuine IDS run recovers', async () => {
  const host = await realHost();
  const source = host.model.store.source;
  const original = source.withMaterializedAsync.bind(source);
  let release: () => void = () => { /* No proof is pending before installation. */ };
  let pending: Promise<JsonRpcMessage | null> | undefined;
  try {
    let entered: () => void = () => { throw new Error('Actual cancellation barrier not installed'); };
    const reached = new Promise<void>(resolveReached => { entered = resolveReached; });
    const pause = new Promise<void>(resolvePause => { release = resolvePause; });
    let first = true;
    source.withMaterializedAsync = async <T,>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> => {
      const actual = await original(fn);
      if (first) { first = false; entered(); await pause; }
      return actual;
    };
    pending = host.transport.send({ jsonrpc: '2.0', id: 7372500, method: 'tools/call',
      params: { name: 'ids_validate', arguments: { model_id: host.model.id, ids_xml: host.xml } } });
    await reached;
    await host.transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7372500 } });
    release(); expect(result(await pending).isError).toBe(true);
    const cancelled = await host.read();
    expect(cancelled.structuredContent?.latestAttempt).toEqual({ state: 'aborted', refusal: 'aborted', proof: null });
    expect(cancelled.structuredContent?.bounds).toMatchObject({ knownFindings: null, nativeCoverageComplete: false });
    const count = failures(await host.call('ids_validate', { model_id: host.model.id, ids_xml: host.xml }));
    const recovered = await host.read();
    expect(recovered.structuredContent?.bounds).toMatchObject({ knownFindings: count, nativeCoverageComplete: true });
    expect(recovered.structuredContent?.latestAttempt).toMatchObject({ state: 'succeeded' }); host.unchanged();
  } finally { release(); if (pending) await Promise.allSettled([pending]);
    source.withMaterializedAsync = original; await host.transport.close(); }
});


for (const producer of ['ids', 'rules', 'flow'] as const) {
  it(`#7372 actual ${producer} producer cancellation abandons a proven reservation and permits native recovery`, async () => {
    const host = await realHost();
    const wall = host.model.bim.query().byType('IfcWall').toArray()[0];
    if (!wall?.globalId) throw new Error('Actual native wall identity is required');
    const ruleSet: RuleSetFile = { version: 1, name: 'Native cancellation invariant', rules: [{
      id: 'native-wall-identity', name: 'Actual wall cannot have the demanded identity',
      applicability: { groups: [{ rules: [Rule.globalId([wall.globalId])], combinator: 'AND' }], authoredAs: 'chips' },
      requirement: { kind: 'element', block: { groups: [{ rules: [Rule.attribute('GlobalId', 'eq', '0000000000000000000000')],
        combinator: 'AND' }], authoredAs: 'chips' } },
    }] };
    const flow = { flowVersion: 1, id: '7372-native-cancellation', name: 'Actual native validation',
      capabilities: ['model.read'], inputs: [], outputs: [{ nodeId: 'validate', port: 'report', label: 'Native report' }],
      nodes: [{ id: 'load', type: 'ids.load', params: { xml: host.xml } }, { id: 'validate', type: 'ids.validate' }],
      edges: [{ from: ['load', 'ids'], to: ['validate', 'ids'] }] };
    const name = producer === 'rules' ? 'check_rules' : producer === 'flow' ? 'run_flow' : 'ids_validate';
    const args = producer === 'rules' ? { rules_json: JSON.stringify(ruleSet) }
      : producer === 'flow' ? { model_id: host.model.id, flow }
      : { model_id: host.model.id, ids_xml: host.xml };
    const nativeReport = (reply: CallToolResult) => {
      if (producer !== 'flow') return failures(reply);
      expect(reply.isError).not.toBe(true); expect(reply.structuredContent?.ok).toBe(true);
      const outputs = reply.structuredContent?.outputs;
      if (!Array.isArray(outputs) || !record(outputs[0]) || !record(outputs[0].data)) throw new Error('Actual Flow native report missing');
      return failures({ content: [], structuredContent: { report: outputs[0].data } });
    };
    const source = host.model.store.source;
    const originalDecode = source.decodeUtf8.bind(source);
    const originalAsync = source.withMaterializedAsync.bind(source);
    const entities = host.model.store.entities;
    const originalGuid = entities.getGlobalId.bind(entities);
    let armed = false, cancelled = 0;
    let cancellation: Promise<JsonRpcMessage | null> | undefined;
    const requestId = 7372600;
    const cancel = () => {
      if (!armed) return;
      armed = false; cancelled++;
      cancellation = host.transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } });
    };
    try {
      const count = nativeReport(await host.call(name, args));
      const control = await host.read();
      // Each hook preserves the authentic data read. It cancels the actual
      // public request from inside the native producer, after capture proof.
      if (producer === 'ids') host.server.attach({ send(message) {
        if ('method' in message && message.method === 'notifications/progress') cancel();
      } });
      if (producer === 'rules') entities.getGlobalId = id => { cancel(); return originalGuid(id); };
      if (producer === 'flow') {
        // The real IDS bridge extracts individual source records through
        // EntityExtractor.decodeUtf8; its resident hash path does not invoke
        // materialize(). Preserve the authentic record before cancelling.
        source.decodeUtf8 = (...args: Parameters<typeof originalDecode>) => {
          const actual = originalDecode(...args); cancel(); return actual;
        };
        source.withMaterializedAsync = async <T,>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> => {
          const actual = await originalAsync(fn); armed = true; return actual;
        };
      } else armed = true;
      const failed = result(await host.transport.send({ jsonrpc: '2.0', id: requestId, method: 'tools/call',
        params: { name, arguments: args, _meta: { progressToken: '7372-native-producer-cancellation' } } }));
      if (cancellation) await cancellation;
      source.withMaterializedAsync = originalAsync; armed = false;
      expect(cancelled).toBe(1);
      expect(failed.isError === true || failed.structuredContent?.ok === false).toBe(true);
      const historical = await host.read();
      expect(historical.structuredContent?.latestAttempt).toMatchObject({ state: 'aborted', refusal: 'aborted' });
      const latest = historical.structuredContent?.latestAttempt;
      expect(record(latest) && record(latest.proof)).toBe(true);
      expect(historical.structuredContent?.provenance).toEqual(control.structuredContent?.provenance);
      expect(historical.structuredContent?.coverage).toEqual(control.structuredContent?.coverage);
      expect(historical.structuredContent?.bounds).toMatchObject({ knownFindings: null, nativeCoverageComplete: false });
      expect(nativeReport(await host.call(name, args))).toBe(count);
      const recovered = await host.read();
      expect(recovered.structuredContent?.latestAttempt).toMatchObject({ state: 'succeeded' });
      expect(recovered.structuredContent?.bounds).toMatchObject({ knownFindings: count, nativeCoverageComplete: true });
      host.unchanged();
    } finally { armed = false; source.decodeUtf8 = originalDecode; source.withMaterializedAsync = originalAsync; entities.getGlobalId = originalGuid;
      if (cancellation) await cancellation; await host.transport.close(); }
  });
}

it('#7372 an older deferred proof cannot revive context history evicted by newer genuine native captures', async () => {
  const host = await realHost();
  failures(await host.call('ids_validate', { model_id: host.model.id, ids_xml: host.xml }));
  const { NativeReviewCaptures, readNativeReview } = await import('@ifc-lite/sdk/review');
  const { parseIDS, validateIDS } = await import('@ifc-lite/ids');
  const { createDataAccessor } = await import('@ifc-lite/ids/bridge');
  const model = host.model;
  const models = () => [{ id: model.id, name: model.name, owner: model, store: model.store, source: model.store.source,
    mutationView: () => model.backend.getMutationView(),
    expressIdOf: (GlobalId: string) => model.store.entities.getExpressIdByGlobalId(GlobalId),
    globalIdOf: (expressId: number) => model.bim.entity({ modelId: model.id, expressId })?.globalId ?? '' }];
  const allowed = (id: string) => id === model.id;
  const captures = new NativeReviewCaptures(2);
  const produce = async (xml: string) => {
    const token = await captures.begin('ids', xml, models(), models, allowed);
    expect(token).not.toBeNull();
    const report = await validateIDS(parseIDS(xml), createDataAccessor(model.store), {
      modelId: model.id, schemaVersion: model.store.schemaVersion, entityCount: model.store.entityCount,
    });
    expect(report.specificationResults.flatMap(spec => spec.entityResults.filter(row => !row.passed)).length).toBeGreaterThan(0);
    captures.finish(token, report); return report;
  };
  const source = model.store.source;
  const original = source.withMaterializedAsync.bind(source);
  let release: () => void = () => { /* No proof is pending before barrier installation. */ };
  let older: ReturnType<typeof produce> | undefined;
  try {
    let entered: () => void = () => { throw new Error('Actual eviction race barrier not installed'); };
    const reached = new Promise<void>(resolveReached => { entered = resolveReached; });
    const pause = new Promise<void>(resolvePause => { release = resolvePause; });
    let first = true;
    source.withMaterializedAsync = async <T,>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> => {
      const actual = await original(fn);
      if (first) { first = false; entered(); await pause; }
      return actual;
    };
    older = produce(host.xml); await reached;
    await produce(host.xml);
    await produce(host.title('Newer distinct context B'));
    await produce(host.title('Newer distinct context C'));
    release(); const oldReport = await older;
    expect(oldReport.specificationResults.some(spec => spec.failedCount > 0)).toBe(true);
    const retained = await readNativeReview(captures, models, { sources: ['validation'] }, allowed);
    expect(retained.runs.map(run => run.label)).toEqual(['Newer distinct context B', 'Newer distinct context C']);
    expect(retained.retention).toMatchObject({ inventoryOmitted: true, omittedHistoricalRuns: null, captureRefusal: 'capture-bound' });
    expect(retained.bounds.nativeCoverageComplete).toBe(false);
    expect(retained.latestAttempt).toMatchObject({ state: 'succeeded' });
    host.unchanged();
  } finally { release(); if (older) await Promise.allSettled([older]);
    source.withMaterializedAsync = original; await host.transport.close(); }
});


it('#7372 a Review hash awaiting return cannot emit a context replaced by newer genuine native settlement', async () => {
  const host = await realHost();
  const source = host.model.store.source;
  const original = source.withMaterializedAsync.bind(source);
  let release: () => void = () => { /* No read is awaiting source proof yet. */ };
  let pending: ReturnType<typeof host.read> | undefined;
  try {
    const count = failures(await host.call('ids_validate', { model_id: host.model.id, ids_xml: host.xml }));
    const before = await host.read();
    let entered: () => void = () => { throw new Error('Actual retained-read barrier not installed'); };
    const reached = new Promise<void>(resolveReached => { entered = resolveReached; });
    const pause = new Promise<void>(resolvePause => { release = resolvePause; });
    let first = true;
    source.withMaterializedAsync = async <T,>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> => {
      const actual = await original(fn);
      if (first) { first = false; entered(); await pause; }
      return actual;
    };
    pending = host.read(); await reached;
    expect(failures(await host.call('ids_validate', { model_id: host.model.id, ids_xml: host.xml }))).toBe(count);
    release(); withheld(await pending, 'capture-bound');
    const current = await host.read();
    expect(current.structuredContent?.bounds).toMatchObject({ knownFindings: count, nativeCoverageComplete: true });
    expect(current.structuredContent?.provenance).not.toEqual(before.structuredContent?.provenance);
    expect(current.structuredContent?.latestAttempt).toMatchObject({ state: 'succeeded' }); host.unchanged();
  } finally { release(); if (pending) await Promise.allSettled([pending]);
    source.withMaterializedAsync = original; await host.transport.close(); }
});
