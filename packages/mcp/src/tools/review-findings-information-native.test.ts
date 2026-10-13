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
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function result(message: JsonRpcMessage | null): CallToolResult {
  expect(message && 'result' in message).toBeTruthy();
  if (!message || !('result' in message)) throw new Error('Actual MCP dispatch did not return a result');
  return message.result as CallToolResult;
}
const caseId = 'mcp:information:all-models:2';
const caseTitle = '#7372 actual MCP native information validation across both revision models is readable as Review facts';
it(caseTitle, async () => {
  const registry = new InMemoryModelRegistry();
  for (const [modelId, filename] of [['arch', 'building-architecture.ifc'], ['rev-b', 'building-architecture-rev-b.ifc']] as const) {
    registry.add(await loadIfcModel(resolve(root, 'apps/viewer/public/samples', filename), { modelId }));
  }
  const models = registry.list();
  expect(models.length).toBe(2);
  const demo: unknown = JSON.parse(await readFile(resolve(root, 'apps/viewer/public/samples/demo-kit.json'), 'utf8'));
  if (!record(demo) || !record(demo.globalIds) || typeof demo.globalIds.dataModified !== 'string') {
    throw new Error('Actual committed revision native identity pin unavailable');
  }
  const nativeGuid = demo.globalIds.dataModified;
  const demanded = '0000000000000000000000';
  expect(nativeGuid).not.toBe(demanded);
  // SAME invariant as viewer runInformationCheck: one authentic subject in
  // each revision source must fail a different GlobalId requirement.
  const ruleSet: RuleSetFile = { version: 1, name: '7372 federated identity invariant', rules: [{
    id: 'same-native-subject', name: 'Native subject must have demanded identity',
    applicability: { groups: [{ rules: [Rule.globalId([nativeGuid])], combinator: 'AND' }], authoredAs: 'chips' },
    requirement: { kind: 'element', block: { groups: [{ rules: [Rule.attribute('GlobalId', 'eq', demanded)], combinator: 'AND' }], authoredAs: 'chips' } },
  }] };
  const originalIds = models.map(model => model.id);
  const before = models.map(model => ({ model, view: model.backend.getMutationView(),
    hash: createHash('sha256').update(model.store.source.materialize()).digest('hex') }));
  expect(new Set(originalIds).size).toBe(2);
  expect(new Set(before.map(owned => owned.hash)).size).toBe(2);
  for (const owned of before) expect(owned.view).toBeNull();
  const server = new MCPServer({ version: '7372-native-n-source-before', registry, scope: fullScope(),
    config: { readOnly: true, samplingEnabled: false }, tools: buildDefaultToolRegistry(),
    resources: new ResourceRegistry(), prompts: new PromptRegistry() });
  const transport = new InProcessTransport(); await transport.connect(server);
  try {
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: '7372-native-n-control', version: '1' } } });
    const analysis = result(await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'check_rules', arguments: { rules_json: JSON.stringify(ruleSet) } } }));
    expect(analysis.isError).not.toBe(true);
    const report = analysis.structuredContent?.report;
    if (!record(report) || !Array.isArray(report.modelInfo) || !Array.isArray(report.specificationResults)) {
      throw new Error('Actual native multi-model information report unavailable');
    }
    expect(record(report.source) && report.source.kind === 'rules').toBe(true);
    expect(report.modelInfo.map(info => record(info) ? info.modelId : null).sort()).toEqual([...originalIds].sort());
    expect(report.specificationResults.length).toBe(1);
    const spec = report.specificationResults[0];
    if (!record(spec) || !Array.isArray(spec.entityResults) || !record(spec.specification)) {
      throw new Error('Actual native multi-model specification rows unavailable');
    }
    expect(spec.error).toBeFalsy();
    expect(spec.setResultsTruncated).not.toBe(true);
    expect(spec.applicableCount).toBe(2);
    expect(spec.entityResults.length).toBe(2);
    expect(typeof spec.specification.id).toBe('string');
    const specificationId = spec.specification.id;
    const expectedEvidence: Array<{ modelId: string; globalId: string; expressId: number; specificationId: string; nativeStatus: string }> = [];
    if (typeof specificationId !== 'string') throw new Error('Actual native specification identity unavailable');
    for (const model of models) {
      const rows = spec.entityResults.filter(row => record(row) && row.modelId === model.id);
      expect(rows.length).toBe(1);
      const row = rows[0];
      if (!record(row) || typeof row.expressId !== 'number') throw new Error('Actual owned native row unavailable');
      expect(Number.isSafeInteger(row.expressId) && row.expressId > 0).toBe(true);
      expect(row.globalId).toBe(nativeGuid);
      expect(row.passed).toBe(false);
      expect(model.store.entities.getGlobalId(row.expressId)).toBe(nativeGuid);
      const info = report.modelInfo.find(candidate => record(candidate) && candidate.modelId === model.id);
      if (!record(info)) throw new Error('Actual native model population unavailable');
      expect(info.entityCount).toBe(model.store.entityCount);
      expectedEvidence.push({ modelId: model.id, globalId: nativeGuid, expressId: row.expressId,
        specificationId, nativeStatus: 'failed' });
    }
    expect(new Set(expectedEvidence.map(row => `${row.modelId}:${row.expressId}`)).size).toBe(2);
    // The report is the actual public return value. Nothing injects it into a
    // nonexistent registry or pretends current MCP retains it for Review.
    console.info('[7372-native-prerequisites-complete]', JSON.stringify({ host: 'mcp', caseId, caseTitle,
      loadedModels: 2, evaluatedModels: 2, specifications: 1, failures: expectedEvidence.length,
      ownedGuidRows: expectedEvidence.length, sourceSHA256: before[0].hash,
      sourceHashes: before.length, maxFindings: 128 }));
    let review: CallToolResult | null = null;
    let dispatchFailure: { error: unknown } | null = null;
    try {
      review = result(await transport.send({ jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'review_findings', arguments: { sources: ['validation'], model_ids: originalIds, max_findings: 128 } } }));
    } catch (error: unknown) { dispatchFailure = { error }; }
    try {
        expect(registry.list().map(model => model.id)).toEqual(originalIds);
        for (const owned of before) {
          expect(registry.list().find(model => model.id === owned.model.id)).toBe(owned.model);
          expect(owned.model.backend.getMutationView()).toBe(owned.view);
          expect(createHash('sha256').update(owned.model.store.source.materialize()).digest('hex')).toBe(owned.hash);
        }
        console.info('[7372-readonly-invariants-complete]', JSON.stringify({ host: 'mcp',
          caseId, caseTitle, loadedModels: 2, sourceHashes: before.length }));
      } catch (invariantError: unknown) {
        console.error('[7372-readonly-invariant-violation]', JSON.stringify({ host: 'mcp',
          caseId, caseTitle, loadedModels: 2,
          message: invariantError instanceof Error ? invariantError.message.slice(0, 512) : null }));
        if (dispatchFailure) throw new AggregateError([dispatchFailure.error, invariantError], 'Review dispatch and readonly invariants failed');
        throw invariantError;
    }
    if (dispatchFailure) throw dispatchFailure.error;
    if (!review) throw new Error('Actual Review dispatcher returned no result');
    const observed = review.structuredContent;
    console.info('[7372-observed-public-review-response]', JSON.stringify({ host: 'mcp', caseId, caseTitle,
      loadedModels: 2, isError: review.isError ?? null,
      code: typeof observed?.code === 'string' ? observed.code.slice(0, 64) : null,
      message: typeof observed?.message === 'string' ? observed.message.slice(0, 512) : null,
      hint: typeof observed?.hint === 'string' ? observed.hint.slice(0, 256) : null,
      content: review.content.slice(0, 2).map(item => item.type === 'text'
        ? { type: item.type, text: item.text.slice(0, 512) } : { type: item.type }),
    }).slice(0, 4096));
    expect(review.isError, 'supported native read must expose the actual native information facts for both evaluated models').not.toBe(true);
    const snapshot = review.structuredContent;
    if (!snapshot || !Array.isArray(snapshot.findings)) throw new Error('Actual multi-model Review findings unavailable');
    expect(snapshot.findings.length).toBe(2);
    const actualEvidence = snapshot.findings.map(finding => {
      if (!record(finding) || !Array.isArray(finding.elements) || finding.elements.length !== 1 || !record(finding.evidence)) {
        throw new Error('Actual Review native per-row evidence unavailable');
      }
      const element = finding.elements[0];
      if (!record(element)) throw new Error('Actual Review native model identity unavailable');
      expect(finding.evidence.kind).toBe('validation');
      expect(finding.evidence.modelId).toBe(element.modelId);
      return { modelId: element.modelId, globalId: element.globalId, expressId: finding.evidence.expressId,
        specificationId: finding.evidence.specificationId, nativeStatus: finding.nativeStatus };
    });
    expect(actualEvidence.sort((a, b) => String(a.modelId).localeCompare(String(b.modelId))))
      .toEqual(expectedEvidence.sort((a, b) => a.modelId.localeCompare(b.modelId)));
    // This discriminates both native rows and their ownership/evidence. Full
    // canonical cards/run/source provenance parity remains later acceptance.
    const selectedPart = result(await transport.send({ jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'review_findings', arguments: { sources: ['validation'], model_ids: [models[0].id] } } }));
    expect(selectedPart.isError).not.toBe(true);
    expect(selectedPart.structuredContent?.sources).toEqual([{ source: 'validation', state: 'unavailable', refusal: 'scope' }]);
    expect(selectedPart.structuredContent?.findings).toEqual([]);
    expect(selectedPart.structuredContent?.provenance).toEqual([]);
    expect(selectedPart.structuredContent?.coverage).toEqual([]);
    expect(selectedPart.structuredContent?.latestAttempt).toBeNull();
    expect(selectedPart.structuredContent?.bounds).toMatchObject({ knownFindings: null, nativeCoverageComplete: false });
    // Revoking one target also suppresses the native run envelope, not just
    // the hidden model's row; specification populations span both targets.
    server.setScope({ scopes: ['read'], modelIds: [models[0].id] });
    const revoked = result(await transport.send({ jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'review_findings', arguments: { sources: ['validation'] } } }));
    expect(revoked.isError).not.toBe(true);
    expect(revoked.structuredContent?.findings).toEqual([]);
    expect(revoked.structuredContent?.runs).toEqual([]);
    expect(revoked.structuredContent?.provenance).toEqual([]);
    expect(revoked.structuredContent?.coverage).toEqual([]);
    expect(revoked.structuredContent?.bounds).toMatchObject({ knownFindings: null, omittedFindings: null });
    const deniedEnvelope = JSON.stringify(revoked);
    expect(deniedEnvelope).not.toContain(models[1].name);
    expect(deniedEnvelope).not.toContain(before[1].hash);
    expect(revoked.structuredContent?.sources).toEqual([{ source: 'validation', state: 'unavailable', refusal: 'scope' }]);
    // Principal refresh is a separate owner boundary, even on the same registry.
    server.setScope({ scopes: ['read'], user: 'different-review-reader' });
    const principal = result(await transport.send({ jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'review_findings', arguments: { sources: ['validation'] } } }));
    expect(principal.structuredContent?.findings).toEqual([]);
    expect(principal.structuredContent?.provenance).toEqual([]);
    expect(principal.structuredContent?.sources).toEqual([{ source: 'validation', state: 'not-run' }]);
  } finally { transport.close(); }
});
