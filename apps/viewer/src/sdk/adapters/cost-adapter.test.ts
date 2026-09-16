/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import type { StoreApi } from './types.js';
import { createCostAdapter } from './cost-adapter.js';

const path = fileURLToPath(new URL('../../../../../tests/models/cost/buildingsmart-cost-composition.ifc', import.meta.url));
const available = existsSync(path);
if (!available) console.warn('skip: canonical cost fixture missing — run `pnpm fixtures`');

describe('#4855 viewer cost adapter', () => {
  it('uses active model ownership and explicit model selection', { skip: !available }, async () => {
    const bytes = new Uint8Array(readFileSync(path));
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
    const modelA = { id: 'a', name: 'Cost A', ifcDataStore: store, schemaVersion: 'IFC4', fileSize: bytes.byteLength, loadedAt: 0, idOffset: 0, maxExpressId: 100 };
    const modelB = { id: 'b', name: 'Cost B', ifcDataStore: store, schemaVersion: 'IFC4', fileSize: bytes.byteLength, loadedAt: 1, idOffset: 1000, maxExpressId: 100 };
    const state = { activeModelId: 'b', ifcDataStore: null, models: new Map([['a', modelA], ['b', modelB]]) };
    const adapter = createCostAdapter({ getState: () => state, subscribe: () => () => {} } as unknown as StoreApi);
    assert.equal(adapter.data().CostItems[0]?.ref.modelId, 'b');
    assert.equal(adapter.data('a').CostItems[0]?.ref.modelId, 'a');
    assert.equal(adapter.evaluateItem({ modelId: 'b', expressId: 42 }).Amount, '2250');
    assert.throws(() => adapter.data('missing'), /Unknown modelId 'missing'/);
  });
});
