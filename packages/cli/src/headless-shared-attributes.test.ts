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
});
