/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it, expect } from 'vitest';
import { runFlow, nodeAvailability, type FlowDocument } from '@ifc-lite/flow';
import { parseCapabilities } from '@ifc-lite/extensions';
import { createFakeBim } from './__tests__/fake-backend.js';
import { createStandardRegistry, BROWSER_FEATURES, headlessFeatures, type FlowHost } from './index.js';
import { sessionNodes } from './session-nodes.js';
import { matchesFilename, parseCheckJobs, parseTagRules } from './session-contracts.js';
const graph = (): FlowDocument => ({ flowVersion: 2, id: 'g', name: 'g', capabilities: ['model.create'], inputs: [], outputs: [],
  nodes: [{ id: 'load', type: 'session.loadModels' }], edges: [] });
const registry = createStandardRegistry();
describe('session automation host boundaries (#6612)', () => {
  it('requires explicit host services in both browser and headless availability', () => {
    for (const node of sessionNodes) for (const features of [BROWSER_FEATURES, headlessFeatures()]) {
      expect(nodeAvailability(node, node.type, features).status).toBe('unavailable');
    }
  });
  it('reports an unavailable loader without executing a model write', async () => {
    const fake = createFakeBim();
    const before = fake.bim.query().count();
    const result = await runFlow(graph(), { registry, host: { bim: fake.bim }, features: headlessFeatures() });
    expect(result.ok).toBe(false);
    expect(result.reports[0].status).toBe('error');
    expect(result.reports[0].error).toMatch(/sessionModels/);
    expect(fake.bim.query().count()).toBe(before);
  });
  it('enforces model.create even when the host advertises the loader capability', async () => {
    const parsed = parseCapabilities(['model.read']);
    if (!parsed.ok) throw new Error('invalid test grants');
    const host: FlowHost = { bim: createFakeBim().bim, grants: parsed.value };
    const result = await runFlow(graph(), { registry, host, features: { ...BROWSER_FEATURES, backend: new Set(['sessionModels']) } });
    expect(result.ok).toBe(false);
    expect(result.reports[0].error).toMatch(/model.create/);
  });
  it('refuses malformed job identities rather than running an ambiguous configuration', () => {
    const job = { id: 'quality', enabled: true, source: { kind: 'slot', slotId: 'checks.files/ids' } };
    expect(parseCheckJobs([job])[0].id).toBe('quality');
    expect(() => parseCheckJobs([job, job])).toThrow(/unique ID/);
    expect(() => parseCheckJobs([{ ...job, targets: [{ kind: 'tagName', tagName: '' }] }])).toThrow(/targets/);
    expect(() => parseCheckJobs([{ ...job, source: { kind: 'arbitrary' } }])).toThrow(/source/);
    expect(() => parseCheckJobs([{ ...job, source: { ...job.source, filename: '' } }])).toThrow(/filename/);
    expect(() => parseCheckJobs([{ ...job, tagBindings: { external: '' } }])).toThrow(/tag bindings/);
    for (const name of [42, '', '   ']) {
      expect(() => parseCheckJobs([{ ...job, source: { kind: 'embedded', value: 1, name } }])).toThrow(/name/);
    }
    expect(parseCheckJobs([{ ...job, source: { kind: 'embedded', value: 1, name: 'Quality check' } }])[0].source)
      .toEqual({ kind: 'embedded', value: 1, name: 'Quality check' });
  });
  it('rejects array-valued filename operators instead of accepting their string coercion (#6612)', () => {
    expect(() => parseTagRules([{ operator: ['glob'], pattern: '*.ifc', tags: ['Architecture'] }])).toThrow(/filename tag rule/);
  });
  it('matches bounded wildcard rules and honors explicit case without treating regex as syntax', () => {
    const [rule] = parseTagRules([{ operator: 'glob', pattern: '*-ARC-??.ifc', tags: ['Architecture'] }]);
    expect(matchesFilename('2026-arc-01.IFC', rule)).toBe(true);
    expect(matchesFilename('2026-ARC-001.ifc', rule)).toBe(false);
    expect(matchesFilename('2026-arc-01.IFC', { ...rule, caseSensitive: true })).toBe(false);
    expect(matchesFilename('a[1].ifc', { operator: 'glob', pattern: 'a[1].ifc', tags: ['Exact'] })).toBe(true);
    expect(matchesFilename('a1.ifc', { operator: 'glob', pattern: 'a[1].ifc', tags: ['Exact'] })).toBe(false);
  });
});
