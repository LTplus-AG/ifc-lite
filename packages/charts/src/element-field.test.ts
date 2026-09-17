/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { EntityFlags } from '@ifc-lite/data';
import { elementsDataset } from './elements-dataset.js';
import { elementFieldColumnId, elementFieldLabel, normalizeElementFieldValue } from './element-field.js';
import type { ElementFieldBinding } from './types.js';

describe('IFC chart fields (#4833)', () => {
  it('uses namespaced tuple identities so separators cannot collide', () => {
    const a: ElementFieldBinding = { kind: 'property', psetName: 'P.set/A', propertyName: 'B.C', valueKind: 'category' };
    const b: ElementFieldBinding = { kind: 'property', psetName: 'P', propertyName: 'set/A.B.C', valueKind: 'category' };
    expect(elementFieldColumnId(a)).not.toBe(elementFieldColumnId(b));
  });

  it('gives every field family a distinct, self-describing identity and label', () => {
    const bindings: ElementFieldBinding[] = [
      { kind: 'quantity', qsetName: 'Qto_WallBaseQuantities', quantityName: 'NetVolume', valueKind: 'number', dataType: 'IFCVOLUMEMEASURE' },
      { kind: 'material', valueKind: 'category' },
      { kind: 'classification', valueKind: 'category' },
      { kind: 'classification', system: 'Uniclass', valueKind: 'category' },
      { kind: 'type', valueKind: 'category' },
      { kind: 'spatial', level: 'Building', valueKind: 'category' },
      { kind: 'spatial', level: 'Site', valueKind: 'category' },
    ];
    expect(new Set(bindings.map(elementFieldColumnId)).size).toBe(bindings.length);
    expect(bindings.map(elementFieldLabel)).toEqual(['Qto_WallBaseQuantities.NetVolume', 'Material', 'Classification', 'Classification (Uniclass)', 'Type name', 'Building', 'Site']);
  });

  it('normalizes supported scalars without numeric coercion of identifiers', () => {
    expect(normalizeElementFieldValue('001', 'category')).toEqual({ value: '001', status: 'value' });
    expect(normalizeElementFieldValue(['IFCBOOLEAN', '.F.'], 'boolean')).toEqual({ value: false, status: 'value' });
    expect(normalizeElementFieldValue(['IFCREAL', 0], 'number')).toEqual({ value: 0, status: 'value' });
    expect(normalizeElementFieldValue('.U.', 'category').status).toBe('missing');
    expect(normalizeElementFieldValue(['a', 'b', 'c'], 'category').status).toBe('unsupported');
    expect(normalizeElementFieldValue({ value: 1 }, 'category').status).toBe('unsupported');
  });

  it('materializes only requested fields and fingerprints value revisions', () => {
    const field: ElementFieldBinding = { kind: 'attribute', attributeName: 'PredefinedType', valueKind: 'category' };
    const model = (revision: number) => ({
      store: {
        entities: {
          count: 2,
          expressId: [4, 9],
          flags: [EntityFlags.HAS_GEOMETRY, EntityFlags.IS_TYPE],
          getName: () => 'Wall',
          getTypeName: () => 'IfcWall',
        },
      },
      name: 'A',
      toGlobalId: (id: number) => id + 100,
      readField: () => 'STANDARD',
      valueRevision: revision,
    });
    const one = elementsDataset([model(1)], [field, field]);
    expect(one.columns.map(({ id }) => id)).toContain(elementFieldColumnId(field));
    expect(one.columns).toHaveLength(5);
    expect(one.rows).toEqual([{ ids: [104], values: ['IfcWall', '', 'A', 'Wall', 'STANDARD'], statuses: ['value', 'value', 'value', 'value', 'value'] }]);
    expect(elementsDataset([model(2)], [field]).fingerprint).not.toBe(one.fingerprint);
  });
});
