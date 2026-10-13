/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7372 / 4254309182: an explicit parameter-dependent service is a whole
 * graph prerequisite, before earlier effects. No model/response is mocked. */
import { expect, it } from 'vitest';
import { NodeRegistry } from './registry.js';
import { runFlow } from './scheduler.js';
import { checkAvailability, type HostFeatures } from './availability.js';
import { FLOW_VERSION, type FlowDocument } from './document.js';
import { createCheckpoint, graphDigest, resumeOutputs } from './checkpoint-record.js';
import { approveCheckpoint, claimCheckpoint, MemoryCheckpointStore, updateCheckpoint } from './checkpoint-state.js';

interface Host { effects: number; modes: unknown[] }
const scalar = { kind: 'scalar', access: 'item' } as const;
const features = (network: boolean, backend = ['store']): HostFeatures => ({ backend: new Set(backend), network, secrets: new Set() });
function registry() {
  return new NodeRegistry<Host>().registerAll([
    { type: 'test.effect', title: 'Effect', category: 'test', inputs: [], outputs: [{ name: 'value', type: scalar }],
      params: [], capabilities: [], writes: 'model', run: ctx => { ctx.host.effects++; return { value: 'effect ran' }; } },
    { type: 'test.service', title: 'Service', category: 'test', inputs: [{ name: 'after', type: scalar, optional: true }],
      outputs: [{ name: 'value', type: scalar }], params: [{ name: 'mode', kind: 'string', default: 'remote' }], capabilities: [],
      requires: { backend: ['store'] }, requiresForParams: params => ({ network: params.mode === 'remote' }),
      run: (ctx, _input, params) => { ctx.host.modes.push(params.mode); return { value: params.mode }; } },
    { type: 'test.pause', title: 'Pause', category: 'test', inputs: [{ name: 'value', type: scalar }],
      outputs: [{ name: 'value', type: scalar }], params: [], capabilities: [], review: 'required',
      run: (_ctx, input) => ({ value: input.value }) },
  ]);
}
function document(): FlowDocument {
  return { flowVersion: FLOW_VERSION, id: 'parameter-preflight', name: 'Parameter prerequisite', capabilities: [],
    nodes: [{ id: 'effect', type: 'test.effect' }, { id: 'read', type: 'test.service' }],
    edges: [{ from: ['effect', 'value'], to: ['read', 'after'] }],
    inputs: [{ nodeId: 'read', param: 'mode', kind: 'scalar', label: 'Read mode' }], outputs: [] };
}

it('#7372 direct runFlow preflights a later derived prerequisite before executing an earlier effect', async () => {
  const host: Host = { effects: 0, modes: [] };
  let error: unknown;
  try { await runFlow(document(), { host, registry: registry(), features: features(false) }); }
  catch (caught) { error = caught; }
  expect(host.effects, 'actual earlier effect counter must remain zero').toBe(0);
  expect(host.modes).toEqual([]);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain('no network bridge');
});

it('#7372 derived prerequisites preserve defaults, Player overrides and union static requirements', async () => {
  const doc = document(), nodes = registry();
  const host: Host = { effects: 0, modes: [] };
  expect(checkAvailability(doc, nodes, features(false), { inputs: { 'read.mode': 'local' } }).every(row => row.status === 'ok')).toBe(true);
  const result = await runFlow(doc, { host, registry: nodes, features: features(false), inputs: { 'read.mode': 'local' } });
  expect(result.ok).toBe(true); expect(host.effects).toBe(1); expect(host.modes).toEqual(['local']);
  const supplied = { ...doc, nodes: doc.nodes.map(node => node.id === 'read' ? { ...node, params: { mode: 'local' } } : node) };
  const second: Host = { effects: 0, modes: [] };
  expect((await runFlow(supplied, { host: second, registry: nodes, features: features(false), inputs: { 'read.mode': undefined } })).ok).toBe(true);
  expect(second.effects).toBe(1); expect(second.modes).toEqual(['local']);
  const denied: Host = { effects: 0, modes: [] };
  await expect(runFlow(doc, { host: denied, registry: nodes, features: features(true, []), inputs: { 'read.mode': 'local' } }))
    .rejects.toThrow('backend feature "store"');
  expect(denied.effects).toBe(0); expect(denied.modes).toEqual([]);
});

it('#7372 only validated restored nodes skip derived services after a real reviewed pause', async () => {
  const nodes = registry(), host: Host = { effects: 0, modes: [] };
  const doc: FlowDocument = { ...document(), nodes: [{ id: 'read', type: 'test.service' }, { id: 'pause', type: 'test.pause' }, { id: 'effect', type: 'test.effect' }],
    edges: [{ from: ['read', 'value'], to: ['pause', 'value'] }, { from: ['pause', 'value'], to: ['effect', 'unused'] }] };
  // The effect uses the pause output as a declared dependency, not a fabricated
  // resume map. Its real run function remains the observable effect boundary.
  const effect = nodes.get('test.effect');
  if (!effect) throw new Error('Actual effect definition required');
  const ordered = new NodeRegistry<Host>().registerAll([effect, nodes.get('test.service')!, nodes.get('test.pause')!])
    .register({ ...effect, type: 'test.after-pause', inputs: [{ name: 'after', type: scalar }], run: effect.run });
  const graph: FlowDocument = { ...doc, nodes: doc.nodes.map(node => node.id === 'effect' ? { ...node, type: 'test.after-pause' } : node),
    edges: [{ from: ['read', 'value'], to: ['pause', 'value'] }, { from: ['pause', 'value'], to: ['effect', 'after'] }] };
  const paused = await runFlow(graph, { host, registry: ordered, features: features(true) });
  expect(paused.review).toEqual(['pause']); expect(host.effects).toBe(0); expect(host.modes).toEqual(['remote']);
  const checkpoint = createCheckpoint({ doc: graph, registry: ordered, result: paused, sourceDigest: 'actual-counter-host' });
  const store = new MemoryCheckpointStore();
  await store.write(approveCheckpoint(checkpoint, checkpoint.proposalDigest), null);
  const claimed = await updateCheckpoint(store, checkpoint.id, current => claimCheckpoint(current, {
    owner: '7372-counter-host', graphDigest: graphDigest(graph, {}, ordered), sourceDigest: 'actual-counter-host', leaseMs: 60_000,
  }));
  const result = await runFlow(graph, { host, registry: ordered, features: features(false), resume: resumeOutputs(claimed) });
  expect(result.ok).toBe(true); expect(host.effects).toBe(1); expect(host.modes).toEqual(['remote']);
  expect(result.reports.find(row => row.nodeId === 'read')?.status).toBe('restored');
  await expect(runFlow(graph, { host, registry: ordered, features: features(false), resume: new Map(paused.outputs) }))
    .rejects.toThrow(/resume requires/);
  expect(host.effects).toBe(1);
});
