/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createHeadlessContext } from './loader.js';

describe('shared CLI live attribute reads (DX2)', () => {
  it('uses one edited value for attributes, queries and exports', async () => {
    const { bim } = await createHeadlessContext(fileURLToPath(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url)));
    const wall = bim.query().byType('IfcWall').first();
    expect(wall).toBeTruthy();
    if (!wall) throw new Error('Committed one-wall fixture has no wall');
    bim.mutate.setAttribute(wall.ref, 'Name', 'Live CLI wall');
    expect(bim.attributes(wall.ref).find(attribute => attribute.name === 'Name')?.value).toBe('Live CLI wall');
    expect(bim.query().byType('IfcWall').first()?.name).toBe('Live CLI wall');
    expect(bim.export.csv([wall.ref], { columns: ['Name'] })).toBe('Name\nLive CLI wall');
    const exported = bim.export.ifc();
    expect(exported).toContain("'Live CLI wall'");
  });
  it('preserves list-valued ordinary properties through CLI CSV export (PR #7646)', async () => {
    const { bim, backend } = await createHeadlessContext(fileURLToPath(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url)));
    const wall = bim.query().byType('IfcWall').first();
    if (!wall) throw new Error('Committed one-wall fixture has no wall');
    bim.mutate.setProperty(wall.ref, 'DX_List', 'Marker', 'prepare overlay');
    const view = backend.getMutationView();
    if (!view) throw new Error('Mutation did not create its overlay');
    view.setProperty(wall.ref.expressId, 'DX_List', 'Choices', ['A', 'B']);
    expect(bim.properties(wall.ref).find(pset => pset.name === 'DX_List')?.properties
      .find(property => property.name === 'Choices')?.value).toEqual(['A', 'B']);
    expect(bim.export.csv([wall.ref], { columns: ['DX_List.Choices'] })).toBe('DX_List.Choices\n"A,B"');
  });
});
