/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #5197: a tracked node whose `NodeDef` has no `remove` hook must not
 * report vanished lanes as removed, and must retain their tracking entries
 * so a later run can retry the removal, exactly like the orphan-sweep path
 * (`packages/flow/src/orphans.ts`) already does.
 *
 * `model.addElement` — the one tracked node in the standard registry — DOES
 * define `remove`, so it stands in here as the no-regression pin against a
 * real IFC-backed store: with the hook present, this fix must not change
 * that vanished lanes are actually removed from the model, counted as
 * removed, and dropped from the tracking store.
 */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFlow, MemoryTrackingStore, parseFlowDocument, type FlowDocument } from '@ifc-lite/flow';
import { createStandardRegistry, headlessFeatures, type FlowHost } from '@ifc-lite/flow-nodes';
import { createHeadlessContext } from '../loader.js';

const here = dirname(fileURLToPath(import.meta.url));
const COLUMNS_FLOW = resolve(here, '../__fixtures__/flows/columns-along-x.flow.json');
const HELLO_WALL = resolve(here, '../../../../apps/viewer/public/samples/hello-wall.ifc');

async function columnsDoc(xs: number[]): Promise<FlowDocument> {
  const doc = parseFlowDocument(await readFile(COLUMNS_FLOW, 'utf-8'));
  return { ...doc, nodes: doc.nodes.map((n) => (n.id === 'xs' ? { ...n, params: { ...n.params, items: xs } } : n)) };
}

describe('model.addElement (real remove hook) — no-regression pin for #5197', () => {
  it('still removes vanished lanes from the model, reports the right removed count, and drops their entries', async () => {
    const { bim } = await createHeadlessContext(HELLO_WALL);
    const host: FlowHost = { bim, defaultModelId: bim.model.activeId() ?? undefined };
    const registry = createStandardRegistry();
    const store = new MemoryTrackingStore();
    const features = headlessFeatures(Object.keys(process.env));
    const columns = () => bim.query().byType('IfcColumn').toArray().map((c) => c.globalId).sort();

    const run1 = await runFlow(await columnsDoc([0, 4, 8]), { host, registry, tracking: store, features });
    expect(run1.ok).toBe(true);
    expect(columns()).toHaveLength(3);
    expect(Object.keys(store.load('columns-along-x/columns')!.entries).sort()).toEqual(['0', '1', '2']);

    const run2 = await runFlow(await columnsDoc([0, 4]), { host, registry, tracking: store, features });
    expect(run2.ok).toBe(true);
    expect(run2.reports.find((r) => r.nodeId === 'add')?.tracking).toEqual({ created: 0, updated: 0, kept: 2, removed: 1 });
    // Removed for real, not just dropped from the count.
    expect(columns()).toHaveLength(2);
    // And its tracking entry is gone too, unlike the no-remove-hook case.
    expect(Object.keys(store.load('columns-along-x/columns')!.entries).sort()).toEqual(['0', '1']);
  });
});
