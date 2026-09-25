/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5351: `IfcCreator` declares IFC4X3 output as `IFC4X3_ADD2`, the ISO
 * 16739-1:2024 identifier for the layouts it writes. IfcOpenShell resolves the
 * bare `IFC4X3` token to a later development schema and rejects those layouts
 * under it. ifc-lite's own parser must still read the output as IFC4X3.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser, parseSourceHeader } from '@ifc-lite/parser';
import { IfcCreator } from './ifc-creator.js';

async function declaredSchema(schema: 'IFC2X3' | 'IFC4' | 'IFC4X3') {
  const creator = new IfcCreator({ Schema: schema, Timestamp: 0 });
  const storey = creator.addIfcBuildingStorey({ Name: 'Level 0', Elevation: 0 });
  creator.addIfcWall(storey, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
  const content = new TextEncoder().encode(creator.toIfc().content);
  const store = await new IfcParser().parseColumnar(content.buffer as ArrayBuffer);
  return { ids: parseSourceHeader(content)?.schemaIdentifiers, family: store.schemaVersion };
}

describe('IfcCreator FILE_SCHEMA identifier (#5351)', () => {
  it('declares IFC4X3 output as IFC4X3_ADD2, which reads back as IFC4X3', async () => {
    expect(await declaredSchema('IFC4X3')).toEqual({ ids: ['IFC4X3_ADD2'], family: 'IFC4X3' });
  });

  it('declares the other families by their own name', async () => {
    expect(await declaredSchema('IFC4')).toEqual({ ids: ['IFC4'], family: 'IFC4' });
    expect(await declaredSchema('IFC2X3')).toEqual({ ids: ['IFC2X3'], family: 'IFC2X3' });
  });
});
