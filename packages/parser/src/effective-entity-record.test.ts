/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { resolveEffectiveEntityRecord } from './effective-entity-record.js';

describe('resolveEffectiveEntityRecord (#5009 review)', () => {
  const wall = {
    type: 'IfcWall',
    attributes: ["'0000000000000000000009'", null, "'Authored'", "'Desc'", "'Kind'", '#40', '#41', "'tag'", '.SOLIDWALL.'],
  };

  it('keeps the authored layout without a retype and applies named then positional edits', () => {
    const record = resolveEffectiveEntityRecord(wall, {
      named: [['Name', "'Renamed'"], ['Description', "'Named desc'"]],
      positional: [[3, "'Positional wins'"]],
    }, 'IFC4');
    expect(record.type).toBe('IfcWall');
    expect(record.attributes[2]).toBe("'Renamed'");
    expect(record.attributes[3]).toBe("'Positional wins'");
    expect(record.attributes[8]).toBe('.SOLIDWALL.');
  });

  it('re-lays a retyped entity out by attribute name into the effective class', () => {
    // IfcWall → IfcRelAggregates: only the IfcRoot slots are shared by name;
    // the wall's placement/representation must not leak into RelatingObject/RelatedObjects.
    const record = resolveEffectiveEntityRecord(wall, {
      retype: 'IfcRelAggregates',
      named: [['RelatingObject', '#2']],
      positional: [],
    }, 'IFC4');
    expect(record.type).toBe('IfcRelAggregates');
    expect(record.names).toEqual(['GlobalId', 'OwnerHistory', 'Name', 'Description', 'RelatingObject', 'RelatedObjects']);
    expect(record.attributes).toEqual(["'0000000000000000000009'", null, "'Authored'", "'Desc'", '#2', null]);
  });

  it('reports a retype to a class with a different header layout from the right slots', () => {
    const rel = { type: 'IfcRelAggregates', attributes: ["'000000000000000000000A'", null, "'Rel'", null, '#2', ['#3']] };
    const record = resolveEffectiveEntityRecord(rel, { retype: 'IfcRelDefinesByType', named: [], positional: [] }, 'IFC4');
    expect(record.names.indexOf('RelatedObjects')).toBe(4);
    expect(record.attributes[4]).toEqual(['#3']);
    expect(record.attributes[5]).toBeNull();
  });
});
