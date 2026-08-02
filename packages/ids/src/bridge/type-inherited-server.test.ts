/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS on server-parsed stores must see TYPE-inherited property sets — the
 * source-backed `extractTypePropertiesOnDemand` bails on the empty `source`
 * buffer, so the bridge falls back to the prebuilt property table keyed by the
 * element's IfcTypeProduct id (issue #1787), mirroring the Lists server-path
 * type fallback. A facet checking a type-only property (incl. one reachable
 * only via a candidate `values[]`) now passes on the server path.
 */

import { describe, it, expect } from 'vitest';
import { RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore, PropertySet } from '@ifc-lite/parser';
import { createDataAccessor } from './data-accessor.js';
import { checkPropertyFacet } from '../facets/property-facet.js';
import type { IDSPropertyFacet, IDSSimpleValue } from '../types.js';

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });

// Server-shaped store: empty `source`; wall #10 --DefinesByType--> type #20;
// the type's Pset_WallCommon lives under the TYPE id in the property table.
function serverStore(): IfcDataStore {
  const typePsets: PropertySet[] = [
    {
      name: 'Pset_WallCommon',
      globalId: '',
      properties: [
        { name: 'FireRating', type: 0, value: 'REI 90' },
        { name: 'AcousticRating', type: 0, value: 'R1, R2', values: ['R1', 'R2'] },
      ],
    } as unknown as PropertySet,
  ];
  return {
    schemaVersion: 'IFC4',
    source: new Uint8Array(), // server path
    entities: {
      getTypeName: (id: number) => (id === 10 ? 'IfcWall' : id === 20 ? 'IfcWallType' : undefined),
      getByType: () => [10],
      getName: () => undefined,
      getGlobalId: () => undefined,
      getDescription: () => undefined,
      getObjectType: () => undefined,
    },
    entityIndex: { byId: new Map(), byType: new Map() },
    relationships: {
      getRelated: (id: number, relType: RelationshipType, dir: 'forward' | 'inverse') =>
        dir === 'inverse' && id === 10 && relType === RelationshipType.DefinesByType ? [20] : [],
    },
    // Instance #10 has no own psets; the type #20 carries them.
    properties: { getForEntity: (id: number) => (id === 20 ? typePsets : []) },
    quantities: { getForEntity: () => [] },
  } as unknown as IfcDataStore;
}

const facet = (val: string): IDSPropertyFacet => ({
  type: 'property',
  propertySet: sv('Pset_WallCommon'),
  baseName: sv('FireRating'),
  value: sv(val),
});

describe('IDS type-inherited psets on server-parsed stores (#1787)', () => {
  it('resolves a type-only property (FireRating from IfcWallType)', () => {
    const accessor = createDataAccessor(serverStore());
    expect(checkPropertyFacet(facet('REI 90'), 10, accessor).passed).toBe(true);
  });

  it('matches a type-only candidate reachable only via values[] (AcousticRating R2)', () => {
    const accessor = createDataAccessor(serverStore());
    const f: IDSPropertyFacet = {
      type: 'property',
      propertySet: sv('Pset_WallCommon'),
      baseName: sv('AcousticRating'),
      value: sv('R2'),
    };
    expect(checkPropertyFacet(f, 10, accessor).passed).toBe(true);
  });

  it('fails value-mismatch on a resolved type property (no false positive)', () => {
    const accessor = createDataAccessor(serverStore());
    // FireRating resolves from the type, but "REI 999" is not its value.
    expect(checkPropertyFacet(facet('REI 999'), 10, accessor).passed).toBe(false);
  });

  it('does not fabricate a property the type lacks (PROPERTY_MISSING)', () => {
    const accessor = createDataAccessor(serverStore());
    const result = checkPropertyFacet(
      { type: 'property', propertySet: sv('Pset_WallCommon'), baseName: sv('LoadBearing') },
      10,
      accessor,
    );
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PROPERTY_MISSING');
  });
});
