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

// #4857 PR A — MCP's `HeadlessLikeBackend` did not pass its MutablePropertyView
// into `createCostBackend` either, so `bim.store.addEntity` (a pre-existing
// entry point; the nine specific cost builders stay stubbed in MCP v0.1) and
// `bim.cost.data()` disagreed about the same loaded model. See the CLI
// counterpart in `packages/cli/src/headless-backend-cost.test.ts` for the
// same witness there.
describe('#4857 MCP headless backend: bim.store.addEntity and bim.cost agree', () => {
  const STEP = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('t.ifc','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;', 'DATA;',
    "#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,$,$);",
    'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n');

  it('a bim.store.addEntity-created IfcCostItem is visible to bim.cost.data() before export', async () => {
    const bytes = new TextEncoder().encode(STEP);
    const store = await new IfcParser().parseColumnar(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      { disableWorkerScan: true },
    );
    const bim = createBimContext({ backend: new HeadlessLikeBackend(store, 't.ifc', 'mcp-t') });
    const ref = bim.store.addEntity('mcp-t', {
      type: 'IfcCostItem',
      attributes: ['0newitem000000000000001', null, 'Freshly authored', null, null, null, '.NOTDEFINED.', null, null],
    });
    const item = bim.cost.data('mcp-t').CostItems.find(i => i.ref.expressId === ref.expressId);
    expect(item?.Name).toBe('Freshly authored');
  });
});
