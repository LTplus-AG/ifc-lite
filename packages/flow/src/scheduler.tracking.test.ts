/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tracked write nodes through the scheduler: create on first run, keep on
 * an identical re-run, update on a param change, remove vanished lanes,
 * retry failed lanes, and `replace` re-creates under fresh GUIDs.
 */

import { describe, expect, it } from 'vitest';
import type { FlowDocument } from './document.js';
import { NodeRegistry, type NodeDef } from './registry.js';
import { ORPHAN_NODE_ID } from './orphans.js';
import { runFlow } from './scheduler.js';
import { MemoryTrackingStore } from './tracking.js';
import { list } from './values.js';

interface Elements {
  created: Map<string, { laneKey: string; value: unknown }>;
  log: string[];
}

const place: NodeDef<Elements> = {
  type: 'test.place',
  title: 'Place',
  category: 'test',
  inputs: [
    { name: 'at', type: { kind: 'entity', access: 'item' } },
    { name: 'size', type: { kind: 'scalar', access: 'item' } },
  ],
  outputs: [{ name: 'entity', type: { kind: 'entity', access: 'item' } }],
  params: [],
  capabilities: ['model.create'],
  writes: 'model',
  tracked: true,
  run: (ctx, inputs) => {
    const t = ctx.tracking!;
    ctx.host.log.push(`${t.action}:${t.globalId}`);
    if (inputs.size === 'boom') throw new Error('boom');
    if (t.action !== 'keep') ctx.host.created.set(t.globalId, { laneKey: ctx.laneKey!, value: inputs.size });
    return { entity: { globalId: t.globalId } };
  },
  remove: (ctx, globalId) => {
    ctx.host.log.push(`remove:${globalId}`);
    ctx.host.created.delete(globalId);
  },
};

const wallsNode = (walls: string[]): NodeDef<Elements> => ({
  type: 'test.walls',
  title: 'Walls',
  category: 'test',
  inputs: [],
  outputs: [{ name: 'walls', type: { kind: 'entity', access: 'list' } }],
  params: [],
  capabilities: [],
  run: () => ({ walls: walls.map((globalId) => ({ globalId })) }),
});

const sizeNode: NodeDef<Elements> = {
  type: 'test.size',
  title: 'Size',
  category: 'test',
  inputs: [],
  outputs: [{ name: 'size', type: { kind: 'scalar', access: 'item' } }],
  params: [{ name: 'value', kind: 'string', default: 's' }],
  capabilities: [],
  run: (_c, _i, p) => ({ size: p.value }),
};

const doc: FlowDocument = {
  flowVersion: 1,
  id: 'g4',
  name: 'columns',
  capabilities: [],
  inputs: [],
  outputs: [],
  nodes: [
    { id: 'walls', type: 'test.walls' },
    { id: 'size', type: 'test.size' },
    { id: 'place', type: 'test.place', label: 'columns at walls' },
  ],
  edges: [
    { from: ['walls', 'walls'], to: ['place', 'at'] },
    { from: ['size', 'size'], to: ['place', 'size'] },
  ],
};

const KEY = 'columns/columns at walls';
const elements = (): Elements => ({ created: new Map(), log: [] });
const reg = (walls: string[]) => new NodeRegistry<Elements>().registerAll([wallsNode(walls), sizeNode, place]);
const trackingOf = (r: Awaited<ReturnType<typeof runFlow>>) => r.reports.find((x) => x.nodeId === 'place')?.tracking;

describe('tracked nodes', () => {
  it('creates, keeps, updates, and removes vanished lanes across runs', async () => {
    const store = new MemoryTrackingStore();
    const e = elements();

    const first = await runFlow(doc, { host: e, registry: reg(['W1', 'W2']), tracking: store });
    expect(trackingOf(first)).toEqual({ created: 2, updated: 0, kept: 0, removed: 0 });
    const guids = [...e.created.keys()];
    expect(guids).toHaveLength(2);
    expect(store.load(KEY)?.entries.W1.globalId).toBe(guids[0]);

    const same = await runFlow(doc, { host: e, registry: reg(['W1', 'W2']), tracking: store });
    expect(trackingOf(same)).toEqual({ created: 0, updated: 0, kept: 2, removed: 0 });
    expect(same.outputs.get('place')?.get('entity')).toEqual(list([{ globalId: guids[0] }, { globalId: guids[1] }]));

    const bigger = await runFlow(doc, { host: e, registry: reg(['W1', 'W2']), tracking: store, inputs: { 'size.value': 'L' } });
    expect(trackingOf(bigger)).toEqual({ created: 0, updated: 2, kept: 0, removed: 0 });
    expect([...e.created.keys()]).toEqual(guids);

    const fewer = await runFlow(doc, { host: e, registry: reg(['W2', 'W3']), tracking: store, inputs: { 'size.value': 'L' } });
    expect(trackingOf(fewer)).toEqual({ created: 1, updated: 0, kept: 1, removed: 1 });
    expect(e.log.filter((l) => l.startsWith('remove:'))).toEqual([`remove:${guids[0]}`]);
    expect(e.created.has(guids[0])).toBe(false);
    expect(e.created.get(guids[1])).toEqual({ laneKey: 'W2', value: 'L' });
  });

  it('GUIDs depend on the tracking key and lane key only — a reload or another graph id changes nothing', async () => {
    const a = elements();
    const b = elements();
    await runFlow(doc, { host: a, registry: reg(['W1']), tracking: new MemoryTrackingStore() });
    await runFlow({ ...doc, id: 'another-id' }, { host: b, registry: reg(['W1']), tracking: new MemoryTrackingStore() });
    expect([...b.created.keys()]).toEqual([...a.created.keys()]);
  });

  it('a lane that failed keeps its previous entry so the next run retries instead of forgetting the element', async () => {
    const store = new MemoryTrackingStore();
    const e = elements();
    await runFlow(doc, { host: e, registry: reg(['W1']), tracking: store });
    const before = store.load(KEY)!.entries.W1;
    const failed = await runFlow(doc, { host: e, registry: reg(['W1']), tracking: store, inputs: { 'size.value': 'boom' } });
    expect(failed.reports.find((r) => r.nodeId === 'place')?.laneErrors).toBe(1);
    expect(store.load(KEY)!.entries.W1).toEqual(before);
    const retried = await runFlow(doc, { host: e, registry: reg(['W1']), tracking: store, inputs: { 'size.value': 'ok' } });
    expect(trackingOf(retried)).toEqual({ created: 0, updated: 1, kept: 0, removed: 0 });
  });

  it('replace mode re-creates every lane under fresh GUIDs and removes the old ones', async () => {
    const store = new MemoryTrackingStore();
    const e = elements();
    const replacing: FlowDocument = { ...doc, nodes: doc.nodes.map((n) => (n.id === 'place' ? { ...n, tracking: 'replace' as const } : n)) };
    await runFlow(replacing, { host: e, registry: reg(['W1']), tracking: store });
    const [g1] = [...e.created.keys()];
    const second = await runFlow(replacing, { host: e, registry: reg(['W1']), tracking: store });
    expect(trackingOf(second)).toEqual({ created: 1, updated: 0, kept: 0, removed: 1 });
    expect(e.created.has(g1)).toBe(false);
    expect(e.created.size).toBe(1);
  });

  it('a duplicate driving entity is skipped, not counted as a failed lane that drops the first lane entry', async () => {
    const store = new MemoryTrackingStore();
    const e = elements();
    const first = await runFlow(doc, { host: e, registry: reg(['W1', 'W1']), tracking: store });
    expect(first.log.some((l) => l.message.includes('duplicate lane key'))).toBe(true);
    expect(trackingOf(first)).toEqual({ created: 1, updated: 0, kept: 0, removed: 0 });
    expect(store.load(KEY)?.entries.W1).toBeDefined();
    // Before: the entry was dropped, and the re-run planned `create` against
    // the element the first run had made.
    const again = await runFlow(doc, { host: e, registry: reg(['W1', 'W1']), tracking: store });
    expect(trackingOf(again)).toEqual({ created: 0, updated: 0, kept: 1, removed: 0 });
    expect(e.created.size).toBe(1);
  });

  it('a set whose node was deleted from the graph is removed from the model and dropped from the store', async () => {
    const store = new MemoryTrackingStore();
    const e = elements();
    await runFlow(doc, { host: e, registry: reg(['W1', 'W2']), tracking: store });
    expect(store.load(KEY)?.nodeType).toBe('test.place');
    const guids = [...e.created.keys()];

    const withoutPlace: FlowDocument = { ...doc, nodes: doc.nodes.filter((n) => n.id !== 'place'), edges: [] };
    const r = await runFlow(withoutPlace, { host: e, registry: reg(['W1', 'W2']), tracking: store });
    expect(r.ok).toBe(true);
    expect(r.writes).toBe(1);
    expect(e.log.filter((l) => l.startsWith('remove:'))).toEqual(guids.map((g) => `remove:${g}`));
    expect(e.created.size).toBe(0);
    expect(store.keys()).toEqual([]);
    expect(r.log.find((l) => l.nodeId === ORPHAN_NODE_ID)?.message).toContain(`removed 2 element(s) of deleted node "${KEY}"`);
  });

  it('a renamed tracking key removes the old set and creates the new one', async () => {
    const store = new MemoryTrackingStore();
    const e = elements();
    await runFlow(doc, { host: e, registry: reg(['W1']), tracking: store });
    const [old] = [...e.created.keys()];
    const renamed: FlowDocument = { ...doc, nodes: doc.nodes.map((n) => (n.id === 'place' ? { ...n, trackingKey: 'columns/v2' } : n)) };
    const r = await runFlow(renamed, { host: e, registry: reg(['W1']), tracking: store });
    expect(trackingOf(r)).toEqual({ created: 1, updated: 0, kept: 0, removed: 0 });
    expect(e.created.has(old)).toBe(false);
    expect(store.keys()).toEqual(['columns/v2']);
  });

  it('an orphaned set whose type is unknown stays in the store, with a warning, rather than being forgotten', async () => {
    const store = new MemoryTrackingStore();
    store.save({ trackingKey: 'columns/gone', generation: 0, entries: { a: { globalId: 'G', digest: 'd' } }, nodeType: 'test.vanished' });
    const e = elements();
    const r = await runFlow(doc, { host: e, registry: reg(['W1']), tracking: store });
    expect(r.ok).toBe(true);
    expect(store.load('columns/gone')).toBeDefined();
    expect(r.log.find((l) => l.nodeId === ORPHAN_NODE_ID)?.level).toBe('warn');
  });

  it('a failed orphan removal keeps the set for the next run and fails the run', async () => {
    const store = new MemoryTrackingStore();
    const e = elements();
    await runFlow(doc, { host: e, registry: reg(['W1']), tracking: store });
    const failingRemove: NodeDef<Elements> = { ...place, remove: () => { throw new Error('locked'); } };
    const registry = new NodeRegistry<Elements>().registerAll([wallsNode(['W1']), sizeNode, failingRemove]);
    const r = await runFlow({ ...doc, nodes: doc.nodes.filter((n) => n.id !== 'place'), edges: [] }, { host: e, registry, tracking: store });
    expect(r.ok).toBe(false);
    expect(store.keys()).toEqual([KEY]);
    expect(r.log.find((l) => l.level === 'error')?.message).toContain('locked');
  });

  it('without a tracking store every run creates, so a caller that wants re-runs must supply one', async () => {
    const e = elements();
    await runFlow(doc, { host: e, registry: reg(['W1']) });
    const r = await runFlow(doc, { host: e, registry: reg(['W1']) });
    expect(trackingOf(r)).toEqual({ created: 1, updated: 0, kept: 0, removed: 0 });
    expect(e.created.size).toBe(1);
  });
});
