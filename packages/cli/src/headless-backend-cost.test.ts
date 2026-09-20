/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { createBimContext } from '@ifc-lite/sdk';
import { HeadlessBackend } from './headless-backend.js';

const path = fileURLToPath(new URL('../../../tests/models/cost/buildingsmart-cost-composition.ifc', import.meta.url));
const available = existsSync(path);
if (!available) console.warn('skip: canonical cost fixture missing — run `pnpm fixtures`');

describe('#4855 CLI cost backend', () => {
  it.skipIf(!available)('exposes the same canonical totals through the headless context', async () => {
    const bytes = new Uint8Array(readFileSync(path));
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
    const bim = createBimContext({ backend: new HeadlessBackend(store, 'cost.ifc') });
    expect(bim.cost.data().source).toBe('loaded-source');
    expect(bim.cost.evaluateItem({ modelId: 'default', expressId: 40 }).Amount).toBe('800');
    expect(bim.cost.evaluateItem({ modelId: 'default', expressId: 41 }).Amount).toBe('1300');
    expect(bim.cost.evaluateItem({ modelId: 'default', expressId: 42 }).Amount).toBe('2250');
    expect(() => bim.cost.data('another-model')).toThrow('Unknown modelId');
  });
});

// #4857 PR A — the CLI headless backend's OWN createCostBackend call did not
// pass its MutablePropertyView, so `bim.store.addEntity` and `bim.cost.data()`
// disagreed about the very same loaded model: an entity created through the
// generic (pre-existing) `bim.store.addEntity` overlay primitive was invisible
// to `bim.cost` no matter what it was. Deliberately uses ONLY that pre-existing
// entry point — no `@ifc-lite/create` builder — so this witness's only subject
// is `headless-backend.ts`'s `this.cost = createCostBackend(...)` wiring, an
// EXISTING file whose diff does not delete anything this test imports.
describe('#4857 CLI headless backend: bim.store.addEntity and bim.cost agree', () => {
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
    const bim = createBimContext({ backend: new HeadlessBackend(store, 't.ifc') });
    const ref = bim.store.addEntity('default', {
      type: 'IfcCostItem',
      attributes: ['0newitem000000000000001', null, 'Freshly authored', null, null, null, '.NOTDEFINED.', null, null],
    });
    const item = bim.cost.data().CostItems.find(i => i.ref.expressId === ref.expressId);
    expect(item?.Name).toBe('Freshly authored');
  });

  it('rejects an empty modelId before cost authoring mutates the default model', async () => {
    const bytes = new TextEncoder().encode(STEP);
    const store = await new IfcParser().parseColumnar(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      { disableWorkerScan: true },
    );
    const bim = createBimContext({ backend: new HeadlessBackend(store, 't.ifc') });
    expect(() => bim.store.addCostItem('', { Name: 'Wrong model' })).toThrow(/Unknown modelId/);
    expect(bim.cost.data().CostItems).toHaveLength(0);
  });

  it('preserves an accepted filename alias in authored cost refs', async () => {
    const bytes = new TextEncoder().encode(STEP);
    const store = await new IfcParser().parseColumnar(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      { disableWorkerScan: true },
    );
    const bim = createBimContext({ backend: new HeadlessBackend(store, 'tower.ifc') });
    expect(bim.store.addCostItem('tower.ifc', { Name: 'Aliased' }).modelId).toBe('tower.ifc');
  });
});
