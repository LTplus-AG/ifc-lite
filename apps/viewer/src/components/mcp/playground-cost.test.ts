/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, parsePlaygroundModel } from './playground-dispatcher.js';

const path = fileURLToPath(new URL('../../../../../tests/models/cost/buildingsmart-cost-composition.ifc', import.meta.url));
const available = existsSync(path);
if (!available) console.warn('skip: canonical cost fixture missing — run `pnpm fixtures`');

describe('#4855 MCP playground cost tools', () => {
  it('dispatches canonical cost data and evaluation', { skip: !available }, async () => {
    const bytes = new Uint8Array(readFileSync(path));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const model = await parsePlaygroundModel(buffer, 'cost.ifc');
    const data = await dispatch(model, 'cost_data', {});
    assert.equal(data.isError, false);
    assert.equal((data.structured as { data: { source: string } }).data.source, 'loaded-source');
    model.bim.mutate.setAttribute({ modelId: model.id, expressId: 42 }, 'Name', 'Overlay-only name');
    const evaluated = await dispatch(model, 'cost_evaluate', { target: 'item', express_id: 42 });
    assert.equal(evaluated.isError, false);
    assert.equal((evaluated.structured as { source: string }).source, 'loaded-source');
    assert.equal((evaluated.structured as { evaluation: { Amount: string } }).evaluation.Amount, '2250');
    const afterOverlay = await dispatch(model, 'cost_data', {});
    const item = (afterOverlay.structured as {
      data: { CostItems: Array<{ ref: { expressId: number }; Name?: string }> };
    }).data.CostItems.find(value => value.ref.expressId === 42);
    assert.equal(item?.Name, 'External wall total');
  });
});
