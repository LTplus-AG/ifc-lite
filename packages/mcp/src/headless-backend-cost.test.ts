/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { createBimContext } from '@ifc-lite/sdk';
import { HeadlessLikeBackend } from './headless-backend.js';

const path = fileURLToPath(new URL('../../../tests/models/cost/buildingsmart-cost-composition.ifc', import.meta.url));
const available = existsSync(path);
if (!available) console.warn('skip: canonical cost fixture missing — run `pnpm fixtures`');

describe('#4855 MCP cost backend', () => {
  it.skipIf(!available)('preserves the registry model id on every projected reference', async () => {
    const bytes = new Uint8Array(readFileSync(path));
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
    const bim = createBimContext({ backend: new HeadlessLikeBackend(store, 'cost.ifc', 'mcp-cost') });
    const data = bim.cost.data('mcp-cost');
    expect(data.CostItems.find(item => item.Name === 'Brick wall')?.ref).toEqual({ modelId: 'mcp-cost', expressId: 41 });
    expect(bim.cost.evaluateItem({ modelId: 'mcp-cost', expressId: 42 })).toMatchObject({ Amount: '2250', Currency: 'GBP' });
    expect(() => bim.cost.data('other')).toThrow('Unknown modelId');
  });
});
