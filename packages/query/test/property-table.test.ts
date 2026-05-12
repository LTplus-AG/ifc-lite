/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { PropertyTable } from '../src/property-table.js';

describe('PropertyTable', () => {
  function makeTable(): PropertyTable {
    return new PropertyTable();
  }

  function makePropSet(name: string, props: Map<string, { type: string; value: any }>) {
    const properties = new Map<string, { type: string; value: any }>();
    for (const [k, v] of props) {
      properties.set(k, v);
    }
    return { name, properties };
  }

  // ── Add & retrieve property sets ──────────────────────────────

  it('should store and retrieve a property set by id', () => {
    const table = makeTable();
    const pset = makePropSet('Pset_WallCommon', new Map([
      ['IsExternal', { type: 'boolean', value: true }],
    ]));

    table.addPropertySet(100, pset);
    // Not directly retrievable without entity association, but should not throw
    expect(table.getProperty(1, 'Pset_WallCommon', 'IsExternal')).toBeNull();
  });

  // ── Associate & get property ──────────────────────────────────

  it('should return the correct property after association', () => {
    const table = makeTable();
    const pset = makePropSet('Pset_WallCommon', new Map([
      ['IsExternal', { type: 'boolean', value: true }],
      ['ThermalTransmittance', { type: 'number', value: 0.24 }],
    ]));

    table.addPropertySet(100, pset);
    table.associatePropertySet(1, 100);

    const result = table.getProperty(1, 'Pset_WallCommon', 'IsExternal');
    expect(result).not.toBeNull();
    expect(result!.value).toBe(true);

    const thermal = table.getProperty(1, 'Pset_WallCommon', 'ThermalTransmittance');
    expect(thermal).not.toBeNull();
    expect(thermal!.value).toBe(0.24);
  });

  it('should return null for a non-existent property name', () => {
    const table = makeTable();
    const pset = makePropSet('Pset_WallCommon', new Map([
      ['IsExternal', { type: 'boolean', value: true }],
    ]));
    table.addPropertySet(100, pset);
    table.associatePropertySet(1, 100);

    expect(table.getProperty(1, 'Pset_WallCommon', 'NoSuchProp')).toBeNull();
  });

  it('should return null for a non-existent pset name', () => {
    const table = makeTable();
    const pset = makePropSet('Pset_WallCommon', new Map([
      ['IsExternal', { type: 'boolean', value: true }],
    ]));
    table.addPropertySet(100, pset);
    table.associatePropertySet(1, 100);

    expect(table.getProperty(1, 'NoSuchPset', 'IsExternal')).toBeNull();
  });

  it('should return null for an entity with no associations', () => {
    const table = makeTable();
    expect(table.getProperty(999, 'Pset_WallCommon', 'IsExternal')).toBeNull();
  });

  // ── Multiple psets per entity ─────────────────────────────────

  it('should support multiple property sets on a single entity', () => {
    const table = makeTable();

    const pset1 = makePropSet('Pset_WallCommon', new Map([
      ['IsExternal', { type: 'boolean', value: true }],
    ]));
    const pset2 = makePropSet('Custom_Props', new Map([
      ['Color', { type: 'string', value: 'Red' }],
    ]));

    table.addPropertySet(100, pset1);
    table.addPropertySet(101, pset2);
    table.associatePropertySet(1, 100);
    table.associatePropertySet(1, 101);

    expect(table.getProperty(1, 'Pset_WallCommon', 'IsExternal')!.value).toBe(true);
    expect(table.getProperty(1, 'Custom_Props', 'Color')!.value).toBe('Red');
  });

  // ── getProperties (all for entity) ────────────────────────────

  it('should return all property sets for an entity', () => {
    const table = makeTable();

    const pset1 = makePropSet('Pset_WallCommon', new Map([
      ['IsExternal', { type: 'boolean', value: true }],
    ]));
    const pset2 = makePropSet('Custom_Props', new Map([
      ['Color', { type: 'string', value: 'Red' }],
    ]));

    table.addPropertySet(100, pset1);
    table.addPropertySet(101, pset2);
    table.associatePropertySet(5, 100);
    table.associatePropertySet(5, 101);

    const all = table.getProperties(5);
    expect(all.size).toBe(2);
    expect(all.has('Pset_WallCommon')).toBe(true);
    expect(all.has('Custom_Props')).toBe(true);
  });

  it('should return empty map for entity with no properties', () => {
    const table = makeTable();
    const all = table.getProperties(999);
    expect(all.size).toBe(0);
  });

  // ── findEntities ──────────────────────────────────────────────

  it('should find entities matching a property value', () => {
    const table = makeTable();
    const pset1 = makePropSet('Pset_WallCommon', new Map([
      ['IsExternal', { type: 'boolean', value: true }],
    ]));
    const pset2 = makePropSet('Pset_WallCommon', new Map([
      ['IsExternal', { type: 'boolean', value: false }],
    ]));

    table.addPropertySet(100, pset1);
    table.addPropertySet(101, pset2);
    table.associatePropertySet(1, 100);
    table.associatePropertySet(2, 101);

    const external = table.findEntities('Pset_WallCommon', 'IsExternal', true);
    expect(external).toEqual([1]);

    const internal = table.findEntities('Pset_WallCommon', 'IsExternal', false);
    expect(internal).toEqual([2]);
  });

  it('should return empty array when no entities match', () => {
    const table = makeTable();
    const result = table.findEntities('Pset_WallCommon', 'IsExternal', true);
    expect(result).toEqual([]);
  });

  // ── Shared property set across entities ───────────────────────

  it('should allow a single property set to be associated with multiple entities', () => {
    const table = makeTable();
    const pset = makePropSet('SharedPset', new Map([
      ['Status', { type: 'string', value: 'Active' }],
    ]));

    table.addPropertySet(200, pset);
    table.associatePropertySet(10, 200);
    table.associatePropertySet(20, 200);

    expect(table.getProperty(10, 'SharedPset', 'Status')!.value).toBe('Active');
    expect(table.getProperty(20, 'SharedPset', 'Status')!.value).toBe('Active');
  });
});
