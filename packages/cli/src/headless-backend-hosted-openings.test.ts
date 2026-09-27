/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6232: `bim.store.addOpening` / `addHostedDoor` / `addHostedWindow` reach
 * the `@ifc-lite/create` builders through the CLI backend and land in
 * `bim.export.ifc()`. Driven through `createBimContext`, the way `ifc-lite eval`
 * and scripts call it, on the committed Bonsai hello-wall sample.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { createBimContext } from '@ifc-lite/sdk';
import { HeadlessBackend } from './headless-backend.js';

const SAMPLE = fileURLToPath(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
const WALL = 1222;

async function context() {
  const bytes = readFileSync(SAMPLE);
  const store = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
  return createBimContext({ backend: new HeadlessBackend(store, 'hello-wall.ifc') });
}

const count = (text: string, type: string) => (text.match(new RegExp(`=${type}\\(`, 'g')) ?? []).length;

describe('#6232 CLI bim.store modelling surface', () => {
  it('authors a hosted door, a hosted window and a bare opening into the exported file', async () => {
    const bim = await context();
    const door = bim.store.addHostedDoor('default', WALL, { Offset: 8, Width: 0.9, Height: 2.1, Name: 'D1' });
    const window = bim.store.addHostedWindow('default', WALL, { Offset: 3.5, Sill: 0.9, Width: 0.6, Height: 1 });
    const opening = bim.store.addOpening('default', WALL, { Offset: 9.3, Sill: 2, Width: 0.3, Height: 0.3 });
    expect([door.modelId, window.modelId, opening.modelId]).toEqual(['default', 'default', 'default']);

    const text = bim.export.ifc(undefined, { schema: 'IFC4' }) as string;
    // The sample already has two filled window openings.
    expect(count(text, 'IFCOPENINGELEMENT')).toBe(5);
    expect(count(text, 'IFCRELVOIDSELEMENT')).toBe(5);
    expect(count(text, 'IFCRELFILLSELEMENT')).toBe(4);
    expect(text).toMatch(new RegExp(`#${door.expressId}=IFCDOOR\\('.{22}',\\$,'D1'`));
    expect(text).toMatch(new RegExp(`=IFCRELVOIDSELEMENT\\('.{22}',\\$,\\$,\\$,#${WALL},#${opening.expressId}\\)`));
  });

  it('refuses a host that is not a wall or slab with the builder message', async () => {
    const bim = await context();
    expect(() => bim.store.addHostedDoor('default', 42, { Offset: 1, Width: 0.9, Height: 2.1 }))
      .toThrow(/IfcWall and IfcSlab/);
  });

  it('types the wall and gives it a layer set usage through bim.store, visible after export', async () => {
    const bim = await context();
    const type = bim.store.addElementType('default', { Type: 'IfcWallType', Name: 'EW-300', PredefinedType: 'SOLIDWALL' });
    const typeRel = bim.store.assignType('default', type.expressId, [WALL]);
    const concrete = bim.store.addMaterial('default', { Name: 'Concrete' });
    const set = bim.store.addMaterialLayerSet('default', { MaterialLayers: [{ Material: concrete.expressId, LayerThickness: 0.1 }] });
    const usage = bim.store.addMaterialLayerSetUsage('default', { ForLayerSet: set.expressId, OffsetFromReferenceLine: 0 });
    bim.store.assignMaterial('default', set.expressId, [type.expressId]);
    const materialRel = bim.store.assignMaterial('default', usage.expressId, [WALL]);

    const text = bim.export.ifc(undefined, { schema: 'IFC4' }) as string;
    expect(text).toMatch(new RegExp(`#${typeRel.expressId}=IFCRELDEFINESBYTYPE\\('.{22}',\\$,\\$,\\$,\\(#${WALL}\\),#${type.expressId}\\)`));
    expect(text).toMatch(new RegExp(`#${materialRel.expressId}=IFCRELASSOCIATESMATERIAL\\('.{22}',\\$,\\$,\\$,\\(#${WALL}\\),#${usage.expressId}\\)`));
    // The sample's own type relationship typed only the wall, so it is gone.
    expect(text).not.toMatch(/^#1224=/m);
    expect(() => bim.store.assignType('default', WALL, [type.expressId])).toThrow(/#1222 is an IFCWALL/);
  });
});
