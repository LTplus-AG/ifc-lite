/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `valueDataTypes` reports each member's IFC type when a list or table has
 * no shared `dataType`, so the IDS bridge can convert each member to SI by
 * its own measure (#7395).
 */

import { describe, it, expect } from 'vitest';
import { parsePropertyValue } from './property-value-parser.js';
import type { IfcEntity } from './types.js';

const entity = (type: string, attributes: unknown[]): IfcEntity =>
  ({ expressId: 1, type, attributes }) as unknown as IfcEntity;

describe('parsePropertyValue member types (#7395)', () => {
  it('reports each table member type, index-aligned with values and skipping nulls', () => {
    const parsed = parsePropertyValue(entity('IFCPROPERTYTABLEVALUE', [
      'Curve', null,
      [['IFCREAL', 1000], ['IFCLABEL', 'A']],
      [['IFCLENGTHMEASURE', 2000], null],
    ]));
    expect(parsed.values).toEqual(['1000', 'A', '2000']);
    expect(parsed.valueDataTypes).toEqual(['IFCREAL', 'IFCLABEL', 'IFCLENGTHMEASURE']);
  });

  it('reports member types for a list that mixes types', () => {
    const parsed = parsePropertyValue(entity('IFCPROPERTYLISTVALUE', [
      'Offsets', null, [['IFCLABEL', 'x'], ['IFCLENGTHMEASURE', 500]], null,
    ]));
    expect(parsed.dataType).toBeUndefined();
    expect(parsed.valueDataTypes).toEqual(['IFCLABEL', 'IFCLENGTHMEASURE']);
  });

  it('omits member types when the list shares one dataType or is untyped', () => {
    const shared = parsePropertyValue(entity('IFCPROPERTYLISTVALUE', [
      'Offsets', null, [['IFCLENGTHMEASURE', 250], ['IFCLENGTHMEASURE', 500]], null,
    ]));
    expect(shared.dataType).toBe('IFCLENGTHMEASURE');
    expect(shared).not.toHaveProperty('valueDataTypes');
    const untyped = parsePropertyValue(entity('IFCPROPERTYLISTVALUE', ['Plain', null, ['a', 'b'], null]));
    expect(untyped).not.toHaveProperty('valueDataTypes');
  });
});
