/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { createFakeBsddClient, createFakeModelBridge, type FakeBsddRecord } from '../testing/index.js';
import { createWorkerModelBridge, serveModelBridge, type BridgePort } from '../worker-bridge.js';
import type { ModelBridge } from '../bridges.js';
import { BSDD_TOOLS } from './bsdd-tools.js';
import { MODEL_TOOLS } from './model-tools.js';
import { createToolRegistry } from './registry.js';
import { doorDoc, entity, sandboxFor, toolContext } from '../../test/helpers.js';

const records = JSON.parse(readFileSync(new URL('../../test/fixtures/bsdd-records.json', import.meta.url), 'utf8')) as FakeBsddRecord[];
const registry = createToolRegistry([...MODEL_TOOLS, ...BSDD_TOOLS]);
type Data = Record<string, unknown>;

const elements = [
  { entity: 'IfcDoor', properties: { 'Pset_DoorCommon.FireRating': 'EI30' } },
  { entity: 'IfcDoor', properties: { 'Pset_DoorCommon.FireRating': 'EI60' } },
  { entity: 'IfcDoor', properties: { 'Pset_DoorCommon.FireRating': 'x'.repeat(300) } },
  { entity: 'IfcWall' },
  { entity: 'IfcSlab' },
];

/** Node's `MessagePort` speaks `on`/`off`; adapt it to the DOM-style port the bridge uses. */
function port(p: import('node:worker_threads').MessagePort): BridgePort {
  const map = new Map<(e: { data: unknown }) => void, (data: unknown) => void>();
  return {
    postMessage: (m) => p.postMessage(m),
    addEventListener: (_t, l) => { const h = (data: unknown) => l({ data }); map.set(l, h); p.on('message', h); },
    removeEventListener: (_t, l) => { const h = map.get(l); if (h) p.off('message', h); },
  };
}

async function viaWorker(impl: ModelBridge) {
  const channel = new MessageChannel();
  const stop = serveModelBridge(port(channel.port2), impl);
  const bridge = createWorkerModelBridge(port(channel.port1));
  return { bridge, close: () => { stop(); bridge.dispose(); channel.port1.close(); channel.port2.close(); } };
}

describe('model tools over the worker bridge', () => {
  it('answer stats, counts, distinct values, inference and coverage from the worker', async () => {
    const fake = createFakeModelBridge(elements);
    const { bridge, close } = await viaWorker(fake);
    try {
      const { doc, specId } = doorDoc();
      const ctx = await toolContext(await sandboxFor(doc), { model: bridge });
      const stats = (await registry.call('model_stats', {}, undefined, ctx)).data as Data;
      expect(stats.models).toMatchObject([{ schema: 'IFC4', elementCount: 5, classes: [{ name: 'IfcDoor', count: 3 }, { name: 'IfcSlab', count: 1 }, { name: 'IfcWall', count: 1 }] }]);

      const bySpec = (await registry.call('model_count', { specId }, undefined, ctx)).data as Data;
      expect(bySpec).toMatchObject({ applicable: 3, passing: 3, stages: [{ facetIndex: -1, count: 5 }, { facetIndex: 0, count: 3 }] });
      const byDraft = (await registry.call('model_count', { applicability: [entity('IfcBeam')] }, undefined, ctx)).data as Data;
      expect(byDraft).toMatchObject({ applicable: 0, warning: expect.any(String) });
      expect((await registry.call('model_count', {}, undefined, ctx)).ok).toBe(false);

      const distinct = (await registry.call('model_distinct_values', { entity: 'IfcDoor', propertySet: 'Pset_DoorCommon', property: 'FireRating', limit: 500 }, undefined, ctx)).data as { values: { value: string }[]; truncated: boolean };
      expect(distinct.values).toHaveLength(3);
      expect(distinct.values.every((v) => v.value.length <= 121)).toBe(true);
      expect(distinct.truncated).toBe(true);

      const inferred = (await registry.call('model_infer', { entity: 'IfcDoor' }, undefined, ctx)).data as { candidates: unknown[] };
      expect(inferred.candidates).toHaveLength(1);
      expect((await registry.call('model_infer', {}, undefined, ctx)).ok).toBe(false);

      const coverage = (await registry.call('model_coverage', {}, undefined, ctx)).data as Data;
      expect(coverage.ungoverned).toEqual([{ name: 'IfcWall', count: 1 }, { name: 'IfcSlab', count: 1 }]);
      expect(fake.calls).toEqual(['stats', 'count', 'count', 'distinctValues', 'infer', 'coverage']);
    } finally {
      close();
    }
  });

  it('cancels a pending request and drops its late answer', async () => {
    let release: (() => void) | undefined;
    const slow = { ...createFakeModelBridge(elements), stats: () => new Promise<never>((_r, reject) => { release = () => reject(new Error('late')); }) };
    const { bridge, close } = await viaWorker(slow);
    try {
      const controller = new AbortController();
      const pending = bridge.stats(controller.signal);
      controller.abort();
      await expect(pending).rejects.toThrow('cancelled');
      release?.();
      await expect(bridge.count({ applicability: [] }, new AbortController().signal)).resolves.toMatchObject({ applicable: 5 });
    } finally {
      close();
    }
  });

  it('reports worker errors as tool errors', async () => {
    const broken = { ...createFakeModelBridge(elements), stats: async () => { throw new Error('model not loaded'); } };
    const { bridge, close } = await viaWorker(broken);
    try {
      const out = await registry.call('model_stats', {}, undefined, await toolContext(await sandboxFor(), { model: bridge }));
      expect(out).toMatchObject({ ok: false, data: { error: 'model not loaded' } });
    } finally {
      close();
    }
  });
});

describe('bSDD tools (recorded responses)', () => {
  it('search, class, properties and resolve answer from the client; only terms and URIs are sent', async () => {
    const client = createFakeBsddClient(records);
    const ctx = await toolContext(await sandboxFor(), { bsdd: client });
    const found = (await registry.call('bsdd_search', { text: 'fire door', relatedIfcEntity: 'IfcDoor' }, undefined, ctx)).data as { results: { code: string; uri: string }[] };
    expect(found.results.map((r) => r.code)).toEqual(['FD-01']);
    const uri = found.results[0].uri;
    expect(((await registry.call('bsdd_class', { uri }, undefined, ctx)).data as Data).name).toBe('Fire door');
    const props = (await registry.call('bsdd_properties', { uri }, undefined, ctx)).data as { properties: { propertySet: string }[] };
    expect(props.properties[0].propertySet).toBe('Pset_DoorCommon');
    expect(((await registry.call('bsdd_resolve_uri', { uri }, undefined, ctx)).data as Data).kind).toBe('class');
    const missing = await registry.call('bsdd_resolve_uri', { uri: 'https://identifier.example.org/none' }, undefined, ctx);
    expect(missing.ok).toBe(false);
    expect((await registry.call('bsdd_class', { uri: 'https://identifier.example.org/none' }, undefined, ctx)).ok).toBe(false);
    expect((await registry.call('bsdd_class', { uri: 'not a uri' }, undefined, ctx)).ok).toBe(false);
    expect(client.requests).toEqual([`search:fire door`, `class:${uri}`, `properties:${uri}`, `resolve:${uri}`, 'resolve:https://identifier.example.org/none', 'class:https://identifier.example.org/none']);
  });

  it('fails cleanly when the host offers no client', async () => {
    const out = await registry.call('bsdd_search', { text: 'door' }, undefined, await toolContext(await sandboxFor()));
    expect(out).toMatchObject({ ok: false, data: { error: 'bSDD is not available.' } });
  });
});
