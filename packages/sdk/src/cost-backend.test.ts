/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_SOURCE_BYTES, IfcParser, type IfcDataStore, type IfcSourceBytes,
} from '@ifc-lite/parser';
import { createCostBackend } from './cost-backend.js';
import { createBimContext } from './context.js';

const fixtureUrl = new URL('../../../tests/models/cost/buildingsmart-cost-composition.ifc', import.meta.url);
const fixturePath = fileURLToPath(fixtureUrl);
const hasFixture = existsSync(fixturePath);
if (!hasFixture) console.warn('skip: canonical cost fixture missing — run `pnpm fixtures`');

async function fixtureStore(): Promise<IfcDataStore> {
  const bytes = new Uint8Array(readFileSync(fixturePath));
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
}

function instrumentSource(source: IfcSourceBytes): { source: IfcSourceBytes; reads: () => number } {
  let readCount = 0;
  return {
    reads: () => readCount,
    source: {
      byteLength: source.byteLength,
      length: source.length,
      isResident: source.isResident,
      contentKey: source.contentKey,
      slice(start, end) { readCount++; return source.slice(start, end); },
      decodeUtf8(start, end) { readCount++; return source.decodeUtf8(start, end); },
      materialize() { readCount++; return source.materialize(); },
      withMaterialized(fn) { readCount++; return source.withMaterialized(fn); },
      withMaterializedAsync(fn) { readCount++; return source.withMaterializedAsync(fn); },
      toTransferable() { return source.toTransferable(); },
    },
  };
}

describe('#4855 cost SDK adapter', () => {
  it.skipIf(!hasFixture)('projects canonical source data and evaluation with model-qualified identity', async () => {
    const store = await fixtureStore();
    const cost = createCostBackend(() => ({ modelId: 'cost-a', store }));
    const graph = cost.data();

    expect(graph).toMatchObject({ modelId: 'cost-a', source: 'loaded-source', SchemaVersion: 'IFC4', Currency: 'GBP', HasCostData: true });
    expect(graph.CostItems.find(item => item.Name === 'Scaffolding')).toMatchObject({
      ref: { modelId: 'cost-a', expressId: 40 }, CostValues: [
        { modelId: 'cost-a', expressId: 30 }, { modelId: 'cost-a', expressId: 31 },
      ],
      CostQuantities: [{ modelId: 'cost-a', expressId: 20 }],
    });
    expect(cost.evaluateItem({ modelId: 'cost-a', expressId: 40 })).toMatchObject({
      ref: { modelId: 'cost-a', expressId: 40 }, Amount: '800', Currency: 'GBP', Diagnostics: [],
    });
    expect(cost.evaluateItem({ modelId: 'cost-a', expressId: 41 }).Amount).toBe('1300');
    expect(cost.evaluateItem({ modelId: 'cost-a', expressId: 42 }).Amount).toBe('2250');
    expect(graph.Relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ Type: 'IfcRelNests', ref: { modelId: 'cost-a', expressId: 60 } }),
    ]));
  });

  it.skipIf(!hasFixture)('returns detached DTOs and reprojects a shared store under each mounted model id', async () => {
    const store = await fixtureStore();
    let mountedAs = 'a';
    const cost = createCostBackend(requested => ({ modelId: requested ?? mountedAs, store }));
    const first = cost.data('a');
    first.CostItems[0]!.Name = 'poisoned';
    first.CostItems[0]!.CostValues?.push({ modelId: 'wrong', expressId: 999 });

    const second = cost.data('b');
    expect(second.CostItems[0]?.Name).not.toBe('poisoned');
    expect(second.CostItems.every(item => item.ref.modelId === 'b')).toBe(true);
    expect(second.CostItems.flatMap(item => item.CostValues ?? []).every(value => value.modelId === 'b')).toBe(true);
    mountedAs = 'survivor';
    expect(cost.evaluateItem({ modelId: mountedAs, expressId: 40 }).ref.modelId).toBe('survivor');
  });

  it.skipIf(!hasFixture)('reuses extraction until the loaded source identity is replaced', async () => {
    const store = await fixtureStore();
    const first = instrumentSource(store.source);
    store.source = first.source;
    const cost = createCostBackend(() => ({ modelId: 'cache', store }));

    expect(cost.data().HasCostData).toBe(true);
    const readsAfterExtraction = first.reads();
    expect(readsAfterExtraction).toBeGreaterThan(0);
    expect(cost.items()).toHaveLength(4);
    expect(first.reads()).toBe(readsAfterExtraction);

    const replacement = instrumentSource(store.source);
    store.source = replacement.source;
    expect(cost.evaluateItem({ modelId: 'cache', expressId: 42 }).Amount).toBe('2250');
    expect(replacement.reads()).toBeGreaterThan(0);
  });

  it('refuses a source-less store instead of reporting an empty cost graph', () => {
    const store = { source: EMPTY_SOURCE_BYTES } as unknown as IfcDataStore;
    const cost = createCostBackend(() => ({ modelId: 'metadata-only', store }));
    expect(() => cost.data()).toThrow("bim.cost requires loaded IFC source bytes for model 'metadata-only'");
  });

  it('reports unsupported and synchronous remote capabilities explicitly', () => {
    const unsupported = createBimContext({ backend: { cost: undefined } as never });
    expect(() => unsupported.cost.data()).toThrow('bim.cost is not supported by this backend');
    const remote = createBimContext({ transport: { send: async request => ({ id: request.id, result: null }), subscribe: () => () => {}, close: () => {} } });
    expect(() => remote.cost.data()).toThrow('RemoteBackend: Cannot call cost.data() synchronously');
  });

  it('rejects evaluation without explicit model ownership', () => {
    const store = { source: EMPTY_SOURCE_BYTES } as unknown as IfcDataStore;
    const cost = createCostBackend(() => ({ modelId: 'default', store }));
    expect(() => cost.evaluateItem({ expressId: 42 } as never))
      .toThrow('bim.cost evaluation requires a model-qualified EntityRef');
  });

  it('rejects unsafe identifiers and impractical decimal precision', () => {
    const backend = createCostBackend(() => { throw new Error('model resolution must not run'); });
    expect(() => backend.evaluateItem(
      { modelId: 'default', expressId: Number.MAX_SAFE_INTEGER + 1 },
    )).toThrow('non-negative safe integer expressId');
    expect(() => backend.evaluateItem(
      { modelId: 'default', expressId: 1 }, { Precision: 10_001 },
    )).toThrow('integer from 1 through 10000');
  });
});
