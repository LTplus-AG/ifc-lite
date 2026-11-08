/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IfcCreator wrote non-ASCII names as raw UTF-8 ('Gartentür'). ISO 10303-21
 * allows only printable ASCII in a literal; everything else is a \X2\ or \X4\
 * directive. `esc` now delegates to `escapeStepString` (@ifc-lite/data).
 */

import { describe, it, expect } from 'vitest';
import { IfcParser, EntityExtractor } from '@ifc-lite/parser';
import { IfcCreator } from './ifc-creator.js';
import { esc } from './ifc-creator-math.js';

describe('IfcCreator non-ASCII text', () => {
  it('esc encodes non-ASCII and control characters as directives', () => {
    expect(esc('Gartentür')).toBe('Gartent\\X2\\00FC\\X0\\r');
    expect(esc('Straße 1\n2')).toBe('Stra\\X2\\00DF\\X0\\e 1\\X2\\000A\\X0\\2');
    expect(esc('🏠')).toBe('\\X4\\0001F3E0\\X0\\');
    expect(esc("it's C:\\x")).toBe("it''s C:\\\\x");
  });

  it('writes an ASCII-only file and reads the names back unchanged', async () => {
    const creator = new IfcCreator({ Name: 'Kleines Haus', Author: 'Louis Trümpler', Timestamp: 0 });
    const storey = creator.addIfcBuildingStorey({ Name: 'Erdgeschoss', Elevation: 0 });
    const wall = creator.addIfcWall(storey, { Name: 'Wand Süd', Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    creator.addIfcWallDoor(wall, { Name: 'Gartentür', Position: [2, 0, 0], Width: 0.9, Height: 2.1 });
    creator.addIfcPropertySet(wall, { Name: 'Pset_WallCommon', Properties: [{ Name: 'Reference', NominalValue: 'Außenwand', Type: 'IfcIdentifier' }] });
    const { content } = creator.toIfc();
    expect(content).toMatch(/^[\x20-\x7E\n]*$/);
    expect(content).toContain("'Gartent\\X2\\00FC\\X0\\r'");

    const bytes = new TextEncoder().encode(content);
    const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer);
    const extractor = new EntityExtractor(store.source);
    const nameOf = (type: string) => (store.entityIndex.byType.get(type) ?? [])
      .map(id => extractor.extractEntity(store.entityIndex.byId.get(id)!)?.attributes?.[2]);
    expect(nameOf('IFCDOOR')).toEqual(['Gartentür']);
    expect(nameOf('IFCWALL')).toEqual(['Wand Süd']);
    expect(nameOf('IFCBUILDINGSTOREY')).toEqual(['Erdgeschoss']);
  });
});
