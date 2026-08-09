/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { matchesCriteria } from './matching.js';
import type { LensCriteria, LensDataProvider, PropertySetInfo } from './types.js';

/** Create a mock provider from a simple entity list */
function createMockProvider(entities: Array<{
  id: number;
  type: string;
  properties?: Record<string, Record<string, unknown>>;
  propertySets?: PropertySetInfo[];
}>): LensDataProvider {
  const entityMap = new Map(entities.map(e => [e.id, e]));

  return {
    getEntityCount: () => entities.length,
    forEachEntity: (cb) => {
      for (const e of entities) cb(e.id, 'model-1');
    },
    getEntityType: (id) => entityMap.get(id)?.type,
    getPropertyValue: (id, pset, prop) => {
      const e = entityMap.get(id);
      return e?.properties?.[pset]?.[prop];
    },
    getPropertySets: (id) => entityMap.get(id)?.propertySets ?? [],
  };
}

describe('matchesCriteria — ifcType', () => {
  const provider = createMockProvider([
    { id: 1, type: 'IfcWall' },
    { id: 2, type: 'IfcWallStandardCase' },
    { id: 3, type: 'IfcSlab' },
  ]);

  it('should match exact type', () => {
    const c: LensCriteria = { type: 'ifcType', ifcType: 'IfcWall' };
    expect(matchesCriteria(c, 1, provider)).toBe(true);
  });

  it('should match subtype to base type', () => {
    const c: LensCriteria = { type: 'ifcType', ifcType: 'IfcWall' };
    expect(matchesCriteria(c, 2, provider)).toBe(true);
  });

  it('should not match different types', () => {
    const c: LensCriteria = { type: 'ifcType', ifcType: 'IfcWall' };
    expect(matchesCriteria(c, 3, provider)).toBe(false);
  });

  it('should not match unknown entity', () => {
    const c: LensCriteria = { type: 'ifcType', ifcType: 'IfcWall' };
    expect(matchesCriteria(c, 999, provider)).toBe(false);
  });

  it('should return false when ifcType is missing in criteria', () => {
    const c: LensCriteria = { type: 'ifcType' };
    expect(matchesCriteria(c, 1, provider)).toBe(false);
  });
});

describe('matchesCriteria — group (#1075)', () => {
  // Spaces 1 & 2 belong to zone "Apt-01"; space 3 belongs to "Apt-02"; entity 4
  // belongs to no group.
  const groupsById = new Map<number, Array<{ id: number; name?: string; type: string }>>([
    [1, [{ id: 90, name: 'Apt-01', type: 'IfcZone' }]],
    [2, [{ id: 90, name: 'Apt-01', type: 'IfcZone' }]],
    [3, [{ id: 91, name: 'Apt-02', type: 'IfcZone' }]],
  ]);
  const provider: LensDataProvider = {
    getEntityCount: () => 4,
    forEachEntity: (cb) => { for (const id of [1, 2, 3, 4]) cb(id, 'model-1'); },
    getEntityType: () => 'IfcSpace',
    getPropertyValue: () => undefined,
    getPropertySets: () => [],
    getEntityGroups: (id) => groupsById.get(id) ?? [],
  };

  it('matches entities in a named zone (case-insensitive substring)', () => {
    const c: LensCriteria = { type: 'group', groupName: 'apt-01' };
    expect(matchesCriteria(c, 1, provider)).toBe(true);
    expect(matchesCriteria(c, 2, provider)).toBe(true);
    expect(matchesCriteria(c, 3, provider)).toBe(false);
  });

  it('matches any grouped entity when groupName is blank', () => {
    const c: LensCriteria = { type: 'group' };
    expect(matchesCriteria(c, 3, provider)).toBe(true);
    expect(matchesCriteria(c, 4, provider)).toBe(false); // no group
  });

  it('returns false when the provider cannot resolve groups', () => {
    const noGroups: LensDataProvider = { ...provider, getEntityGroups: undefined };
    const c: LensCriteria = { type: 'group', groupName: 'Apt-01' };
    expect(matchesCriteria(c, 1, noGroups)).toBe(false);
  });
});

describe('matchesCriteria — property', () => {
  const provider = createMockProvider([
    {
      id: 1,
      type: 'IfcWall',
      properties: {
        'Pset_WallCommon': { IsExternal: 'true', FireRating: 'REI60' },
      },
    },
    {
      id: 2,
      type: 'IfcSlab',
      properties: {},
    },
  ]);

  it('should match equals operator', () => {
    const c: LensCriteria = {
      type: 'property',
      propertySet: 'Pset_WallCommon',
      propertyName: 'IsExternal',
      operator: 'equals',
      propertyValue: 'true',
    };
    expect(matchesCriteria(c, 1, provider)).toBe(true);
  });

  it('should not match wrong value with equals', () => {
    const c: LensCriteria = {
      type: 'property',
      propertySet: 'Pset_WallCommon',
      propertyName: 'IsExternal',
      operator: 'equals',
      propertyValue: 'false',
    };
    expect(matchesCriteria(c, 1, provider)).toBe(false);
  });

  // The properties panel shows IFC booleans capitalized ("True"/"False"), but
  // String(boolean) is lowercase. A user typing what they see must still
  // match. Genuinely case-sensitive strings stay strict. (#1403)
  it('should match a capitalized boolean against a lowercase stored value', () => {
    const c: LensCriteria = {
      type: 'property',
      propertySet: 'Pset_WallCommon',
      propertyName: 'IsExternal',
      operator: 'equals',
      propertyValue: 'True',
    };
    expect(matchesCriteria(c, 1, provider)).toBe(true);
  });

  it('should match a boolean regardless of either side casing', () => {
    const boolProvider = createMockProvider([
      { id: 1, type: 'IfcWall', properties: { Pset_X: { LoadBearing: true } } },
      { id: 2, type: 'IfcWall', properties: { Pset_X: { LoadBearing: false } } },
    ]);
    const truthy: LensCriteria = { type: 'property', propertySet: 'Pset_X', propertyName: 'LoadBearing', operator: 'equals', propertyValue: 'TRUE' };
    const falsy: LensCriteria = { type: 'property', propertySet: 'Pset_X', propertyName: 'LoadBearing', operator: 'equals', propertyValue: 'False' };
    expect(matchesCriteria(truthy, 1, boolProvider)).toBe(true);
    expect(matchesCriteria(truthy, 2, boolProvider)).toBe(false);
    expect(matchesCriteria(falsy, 2, boolProvider)).toBe(true);
    expect(matchesCriteria(falsy, 1, boolProvider)).toBe(false);
  });

  it('should keep non-boolean equals case-sensitive', () => {
    const c: LensCriteria = {
      type: 'property',
      propertySet: 'Pset_WallCommon',
      propertyName: 'FireRating',
      operator: 'equals',
      propertyValue: 'rei60', // stored as 'REI60'
    };
    expect(matchesCriteria(c, 1, provider)).toBe(false);
  });

  it('should match contains operator (case-insensitive)', () => {
    const c: LensCriteria = {
      type: 'property',
      propertySet: 'Pset_WallCommon',
      propertyName: 'FireRating',
      operator: 'contains',
      propertyValue: 'rei',
    };
    expect(matchesCriteria(c, 1, provider)).toBe(true);
  });

  it('should match exists operator', () => {
    const c: LensCriteria = {
      type: 'property',
      propertySet: 'Pset_WallCommon',
      propertyName: 'IsExternal',
      operator: 'exists',
    };
    expect(matchesCriteria(c, 1, provider)).toBe(true);
  });

  it('should fail exists when property is missing', () => {
    const c: LensCriteria = {
      type: 'property',
      propertySet: 'Pset_WallCommon',
      propertyName: 'LoadBearing',
      operator: 'exists',
    };
    expect(matchesCriteria(c, 1, provider)).toBe(false);
  });

  it('should return false when propertySet/Name missing in criteria', () => {
    expect(matchesCriteria({ type: 'property' }, 1, provider)).toBe(false);
    expect(matchesCriteria({ type: 'property', propertySet: 'x' }, 1, provider)).toBe(false);
  });
});

describe('matchesCriteria — attribute', () => {
  const provider = createMockProvider([
    { id: 1, type: 'IfcWall' },
    { id: 2, type: 'IfcSlab' },
  ]);

  // Add attribute methods to the provider
  (provider as Record<string, unknown>).getEntityAttribute = (id: number, attrName: string) => {
    if (id === 1) {
      if (attrName === 'Name') return 'Exterior Wall 200';
      if (attrName === 'Description') return 'Load-bearing exterior wall';
      if (attrName === 'ObjectType') return 'Standard';
    }
    if (id === 2) {
      if (attrName === 'Name') return 'Floor Slab';
    }
    return undefined;
  };

  it('should match attribute by contains (case-insensitive)', () => {
    const c: LensCriteria = {
      type: 'attribute',
      attributeName: 'Name',
      operator: 'contains',
      attributeValue: 'exterior',
    };
    expect(matchesCriteria(c, 1, provider)).toBe(true);
    expect(matchesCriteria(c, 2, provider)).toBe(false);
  });

  it('should match attribute by equals (exact match)', () => {
    const c: LensCriteria = {
      type: 'attribute',
      attributeName: 'ObjectType',
      attributeValue: 'Standard',
    };
    expect(matchesCriteria(c, 1, provider)).toBe(true);
  });

  it('should match attribute exists', () => {
    const c: LensCriteria = {
      type: 'attribute',
      attributeName: 'Description',
      operator: 'exists',
    };
    expect(matchesCriteria(c, 1, provider)).toBe(true);
    expect(matchesCriteria(c, 2, provider)).toBe(false);
  });

  it('should return false when attributeName is missing', () => {
    expect(matchesCriteria({ type: 'attribute' }, 1, provider)).toBe(false);
  });

  it('should return false when provider lacks getEntityAttribute', () => {
    const basicProvider = createMockProvider([{ id: 1, type: 'IfcWall' }]);
    expect(matchesCriteria({ type: 'attribute', attributeName: 'Name' }, 1, basicProvider)).toBe(false);
  });
});

describe('matchesCriteria — quantity', () => {
  const provider = createMockProvider([
    { id: 1, type: 'IfcWall' },
    { id: 2, type: 'IfcSlab' },
  ]);

  (provider as Record<string, unknown>).getQuantityValue = (id: number, qset: string, qname: string) => {
    if (id === 1 && qset === 'Qto_WallBaseQuantities') {
      if (qname === 'Length') return 5.2;
      if (qname === 'Height') return 2.8;
    }
    return undefined;
  };

  it('should match quantity exists', () => {
    const c: LensCriteria = {
      type: 'quantity',
      quantitySet: 'Qto_WallBaseQuantities',
      quantityName: 'Length',
      operator: 'exists',
    };
    expect(matchesCriteria(c, 1, provider)).toBe(true);
    expect(matchesCriteria(c, 2, provider)).toBe(false);
  });

  it('should match quantity equals (stringified)', () => {
    const c: LensCriteria = {
      type: 'quantity',
      quantitySet: 'Qto_WallBaseQuantities',
      quantityName: 'Length',
      operator: 'equals',
      quantityValue: '5.2',
    };
    expect(matchesCriteria(c, 1, provider)).toBe(true);
  });

  it('should return false when quantitySet/Name missing', () => {
    expect(matchesCriteria({ type: 'quantity' }, 1, provider)).toBe(false);
    expect(matchesCriteria({ type: 'quantity', quantitySet: 'x' }, 1, provider)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Comparison operators (ne / gt / gte / lt / lte)
//
// Semantics are ported from the viewer's search rule model
// (apps/viewer/src/lib/search/filter-rules.ts, `valueOpMatches`): the four
// numeric ops parse BOTH sides with Number.parseFloat and match only when both
// parse finite; `ne` is a string comparison, not a numeric one. A missing value
// never matches any of the five.
// ---------------------------------------------------------------------------

describe('matchesCriteria — comparison operators on quantity', () => {
  const provider = createMockProvider([
    { id: 1, type: 'IfcWall' },
    { id: 2, type: 'IfcSlab' },
    { id: 3, type: 'IfcWall' },
  ]);

  (provider as Record<string, unknown>).getQuantityValue = (id: number, qset: string, qname: string) => {
    if (qset !== 'Qto_WallBaseQuantities') return undefined;
    if (id === 1 && qname === 'Volume') return 12.5;
    if (id === 2 && qname === 'Volume') return 3;
    // A quantity that arrived as a numeric *string* rather than a number.
    if (id === 3 && qname === 'Volume') return '300';
    if (id === 1 && qname === 'Label') return 'not-a-number';
    return undefined;
  };

  const q = (operator: LensCriteria['operator'], quantityValue: string, quantityName = 'Volume'): LensCriteria => ({
    type: 'quantity',
    quantitySet: 'Qto_WallBaseQuantities',
    quantityName,
    operator,
    quantityValue,
  });

  it('should match quantity gt', () => {
    expect(matchesCriteria(q('gt', '10'), 1, provider)).toBe(true);
    expect(matchesCriteria(q('gt', '10'), 2, provider)).toBe(false);
    // Boundary: gt is strict.
    expect(matchesCriteria(q('gt', '12.5'), 1, provider)).toBe(false);
  });

  it('should match quantity gte', () => {
    // Strictly-greater case first: equality alone cannot satisfy this.
    expect(matchesCriteria(q('gte', '10'), 1, provider)).toBe(true);
    expect(matchesCriteria(q('gte', '12.5'), 1, provider)).toBe(true);
    expect(matchesCriteria(q('gte', '12.6'), 1, provider)).toBe(false);
  });

  it('should match quantity lt', () => {
    expect(matchesCriteria(q('lt', '10'), 2, provider)).toBe(true);
    expect(matchesCriteria(q('lt', '10'), 1, provider)).toBe(false);
    expect(matchesCriteria(q('lt', '3'), 2, provider)).toBe(false);
  });

  it('should match quantity lte', () => {
    // Strictly-less case first: equality alone cannot satisfy this.
    expect(matchesCriteria(q('lte', '20'), 2, provider)).toBe(true);
    expect(matchesCriteria(q('lte', '3'), 2, provider)).toBe(true);
    expect(matchesCriteria(q('lte', '2.9'), 2, provider)).toBe(false);
  });

  it('should match quantity ne as a string comparison, not a numeric one', () => {
    expect(matchesCriteria(q('ne', '3'), 1, provider)).toBe(true);
    expect(matchesCriteria(q('ne', '12.5'), 1, provider)).toBe(false);
  });

  // A quantity stored as the string "300" must compare numerically — providers
  // surface quantities as `number | string` and the string form is common.
  it('should compare a numeric-string quantity value numerically', () => {
    expect(matchesCriteria(q('gt', '299'), 3, provider)).toBe(true);
    expect(matchesCriteria(q('lt', '299'), 3, provider)).toBe(false);
    expect(matchesCriteria(q('gte', '300'), 3, provider)).toBe(true);
  });

  it('should not match a numeric operator against a non-numeric quantity', () => {
    expect(matchesCriteria(q('gt', '0', 'Label'), 1, provider)).toBe(false);
    expect(matchesCriteria(q('gte', '0', 'Label'), 1, provider)).toBe(false);
    expect(matchesCriteria(q('lt', '0', 'Label'), 1, provider)).toBe(false);
    expect(matchesCriteria(q('lte', '0', 'Label'), 1, provider)).toBe(false);
  });

  it('should not match a numeric operator whose criteria value is non-numeric', () => {
    expect(matchesCriteria(q('gt', 'ten'), 1, provider)).toBe(false);
    expect(matchesCriteria(q('lt', 'ten'), 1, provider)).toBe(false);
  });

  it('should not match any comparison operator when the quantity is absent', () => {
    for (const op of ['ne', 'gt', 'gte', 'lt', 'lte'] as const) {
      expect(matchesCriteria(q(op, '0'), 2, { ...provider, getQuantityValue: () => undefined })).toBe(false);
    }
  });

  it('should not match a comparison operator with no criteria value set', () => {
    const c: LensCriteria = {
      type: 'quantity',
      quantitySet: 'Qto_WallBaseQuantities',
      quantityName: 'Volume',
      operator: 'gt',
    };
    expect(matchesCriteria(c, 1, provider)).toBe(false);
  });
});

describe('matchesCriteria — comparison operators on property', () => {
  const provider = createMockProvider([
    {
      id: 1,
      type: 'IfcWall',
      properties: {
        Pset_WallCommon: { FireRating: '60', Thickness: 300, IsExternal: 'true', Note: 'REI60' },
      },
    },
    { id: 2, type: 'IfcSlab', properties: {} },
  ]);

  const p = (operator: LensCriteria['operator'], propertyName: string, propertyValue: string): LensCriteria => ({
    type: 'property',
    propertySet: 'Pset_WallCommon',
    propertyName,
    operator,
    propertyValue,
  });

  it('should match property gte / lt on a numeric-string value', () => {
    expect(matchesCriteria(p('gte', 'FireRating', '60'), 1, provider)).toBe(true);
    expect(matchesCriteria(p('gte', 'FireRating', '61'), 1, provider)).toBe(false);
    expect(matchesCriteria(p('lt', 'FireRating', '90'), 1, provider)).toBe(true);
  });

  it('should match property gt / lte on a numeric value', () => {
    expect(matchesCriteria(p('gt', 'Thickness', '200'), 1, provider)).toBe(true);
    expect(matchesCriteria(p('gt', 'Thickness', '300'), 1, provider)).toBe(false);
    expect(matchesCriteria(p('lte', 'Thickness', '300'), 1, provider)).toBe(true);
  });

  it('should match property ne', () => {
    expect(matchesCriteria(p('ne', 'IsExternal', 'false'), 1, provider)).toBe(true);
    expect(matchesCriteria(p('ne', 'IsExternal', 'true'), 1, provider)).toBe(false);
  });

  // `ne` reuses the same equality test as `equals`, so the two stay exact
  // complements — including the boolean case tolerance (#1403).
  it('should keep ne the exact complement of equals for booleans', () => {
    expect(matchesCriteria(p('ne', 'IsExternal', 'True'), 1, provider)).toBe(false);
  });

  // NaN comparisons are false on their own, but a non-finite value that DOES
  // compare — Infinity, from a corrupt or placeholder value — would satisfy
  // every gt/gte without the isFinite guard.
  it('should not match a numeric operator against a non-finite value', () => {
    const infProvider = createMockProvider([
      { id: 1, type: 'IfcWall', properties: { Pset_X: { Volume: Infinity, Text: 'Infinity' } } },
    ]);
    const inf = (propertyName: string): LensCriteria => ({
      type: 'property', propertySet: 'Pset_X', propertyName, operator: 'gt', propertyValue: '10',
    });
    expect(matchesCriteria(inf('Volume'), 1, infProvider)).toBe(false);
    expect(matchesCriteria(inf('Text'), 1, infProvider)).toBe(false);
    // ...and a non-finite value on the criteria side is rejected too.
    const infCriteria: LensCriteria = {
      type: 'property', propertySet: 'Pset_X', propertyName: 'Volume',
      operator: 'lt', propertyValue: 'Infinity',
    };
    expect(matchesCriteria(infCriteria, 1, infProvider)).toBe(false);
  });

  it('should not match a numeric operator against a non-numeric property (fails closed)', () => {
    expect(matchesCriteria(p('gt', 'Note', '0'), 1, provider)).toBe(false);
    expect(matchesCriteria(p('gte', 'Note', '0'), 1, provider)).toBe(false);
    expect(matchesCriteria(p('lt', 'Note', '999999'), 1, provider)).toBe(false);
    expect(matchesCriteria(p('lte', 'Note', '999999'), 1, provider)).toBe(false);
  });

  it('should not match any comparison operator when the property is absent', () => {
    for (const op of ['ne', 'gt', 'gte', 'lt', 'lte'] as const) {
      expect(matchesCriteria(p(op, 'Thickness', '0'), 2, provider)).toBe(false);
    }
  });
});

describe('matchesCriteria — comparison operators on attribute', () => {
  const provider = createMockProvider([
    { id: 1, type: 'IfcWall' },
    { id: 2, type: 'IfcSlab' },
  ]);

  (provider as Record<string, unknown>).getEntityAttribute = (id: number, attrName: string) => {
    if (id === 1) {
      if (attrName === 'Name') return 'Exterior Wall 200';
      if (attrName === 'Tag') return '450';
    }
    if (id === 2 && attrName === 'Tag') return '';
    return undefined;
  };

  const a = (operator: LensCriteria['operator'], attributeName: string, attributeValue: string): LensCriteria => ({
    type: 'attribute',
    attributeName,
    operator,
    attributeValue,
  });

  it('should match attribute numeric operators on a numeric-string tag', () => {
    expect(matchesCriteria(a('gt', 'Tag', '400'), 1, provider)).toBe(true);
    expect(matchesCriteria(a('lt', 'Tag', '400'), 1, provider)).toBe(false);
    expect(matchesCriteria(a('gte', 'Tag', '450'), 1, provider)).toBe(true);
    expect(matchesCriteria(a('lte', 'Tag', '450'), 1, provider)).toBe(true);
  });

  it('should match attribute ne', () => {
    expect(matchesCriteria(a('ne', 'Name', 'Floor Slab'), 1, provider)).toBe(true);
    expect(matchesCriteria(a('ne', 'Name', 'Exterior Wall 200'), 1, provider)).toBe(false);
  });

  it('should not match a numeric operator against a non-numeric attribute', () => {
    expect(matchesCriteria(a('gt', 'Name', '0'), 1, provider)).toBe(false);
    expect(matchesCriteria(a('lt', 'Name', '99999'), 1, provider)).toBe(false);
  });

  it('should not match any comparison operator when the attribute is absent or empty', () => {
    for (const op of ['ne', 'gt', 'gte', 'lt', 'lte'] as const) {
      expect(matchesCriteria(a(op, 'Name', '0'), 2, provider)).toBe(false);
      expect(matchesCriteria(a(op, 'Tag', '0'), 2, provider)).toBe(false);
    }
  });
});

describe('matchesCriteria — comparison operators are ignored by the other criteria types', () => {
  const provider = createMockProvider([{ id: 1, type: 'IfcWall' }]);

  it('should still match ifcType when a comparison operator is set', () => {
    const c: LensCriteria = { type: 'ifcType', ifcType: 'IfcWall', operator: 'gt' };
    expect(matchesCriteria(c, 1, provider)).toBe(true);
  });
});

describe('matchesCriteria — classification', () => {
  const provider = createMockProvider([
    { id: 1, type: 'IfcWall' },
    { id: 2, type: 'IfcSlab' },
  ]);

  (provider as Record<string, unknown>).getClassifications = (id: number) => {
    if (id === 1) {
      return [{ system: 'Uniclass', identification: 'Pr_60_10_32', name: 'Walls' }];
    }
    return [];
  };

  it('should match classification by system', () => {
    const c: LensCriteria = {
      type: 'classification',
      classificationSystem: 'Uniclass',
    };
    expect(matchesCriteria(c, 1, provider)).toBe(true);
    expect(matchesCriteria(c, 2, provider)).toBe(false);
  });

  it('should match classification by code (case-insensitive substring)', () => {
    const c: LensCriteria = {
      type: 'classification',
      classificationCode: 'pr_60',
    };
    expect(matchesCriteria(c, 1, provider)).toBe(true);
  });

  it('should match classification by system AND code', () => {
    const c: LensCriteria = {
      type: 'classification',
      classificationSystem: 'uniclass',
      classificationCode: 'Pr_60_10_32',
    };
    expect(matchesCriteria(c, 1, provider)).toBe(true);
  });

  it('should return false when neither system nor code specified', () => {
    expect(matchesCriteria({ type: 'classification' }, 1, provider)).toBe(false);
  });

  it('should return false when provider lacks getClassifications', () => {
    const basicProvider = createMockProvider([{ id: 1, type: 'IfcWall' }]);
    expect(matchesCriteria({ type: 'classification', classificationSystem: 'x' }, 1, basicProvider)).toBe(false);
  });
});

describe('matchesCriteria — material', () => {
  const provider = createMockProvider([
    {
      id: 1,
      type: 'IfcWall',
      propertySets: [
        {
          name: 'Pset_MaterialCommon',
          properties: [
            { name: 'Material', value: 'Concrete C30/37' },
          ],
        },
        {
          name: 'Pset_WallCommon',
          properties: [
            { name: 'IsExternal', value: true },
          ],
        },
      ],
    },
    {
      id: 2,
      type: 'IfcColumn',
      propertySets: [
        {
          name: 'Pset_ColumnCommon',
          properties: [
            { name: 'Reference', value: 'S235' },
          ],
        },
      ],
    },
  ]);

  it('should match material in material-related psets', () => {
    const c: LensCriteria = { type: 'material', materialName: 'concrete' };
    expect(matchesCriteria(c, 1, provider)).toBe(true);
  });

  it('should not match in non-material psets', () => {
    const c: LensCriteria = { type: 'material', materialName: 'External' };
    // "External" exists in Pset_WallCommon, but that pset name doesn't contain "material"
    expect(matchesCriteria(c, 1, provider)).toBe(false);
  });

  it('should not match when no material psets exist', () => {
    const c: LensCriteria = { type: 'material', materialName: 'steel' };
    expect(matchesCriteria(c, 2, provider)).toBe(false);
  });

  it('should return false when materialName is missing', () => {
    expect(matchesCriteria({ type: 'material' }, 1, provider)).toBe(false);
  });
});

describe('matchesCriteria — model', () => {
  const entities = [
    { id: 1, type: 'IfcWall', modelId: 'model-a' },
    { id: 2, type: 'IfcSlab', modelId: 'model-a' },
    { id: 3, type: 'IfcColumn', modelId: 'model-b' },
  ];

  function createModelProvider(includeGetModelId = true): LensDataProvider {
    const entityMap = new Map(entities.map(e => [e.id, e]));
    const provider: LensDataProvider = {
      getEntityCount: () => entities.length,
      forEachEntity: (cb) => {
        for (const e of entities) cb(e.id, e.modelId);
      },
      getEntityType: (id) => entityMap.get(id)?.type,
      getPropertyValue: () => undefined,
      getPropertySets: () => [],
    };
    if (includeGetModelId) {
      provider.getModelId = (id) => entityMap.get(id)?.modelId;
    }
    return provider;
  }

  it('should match entities from the specified model', () => {
    const c: LensCriteria = { type: 'model', modelId: 'model-a' };
    expect(matchesCriteria(c, 1, createModelProvider())).toBe(true);
    expect(matchesCriteria(c, 2, createModelProvider())).toBe(true);
  });

  it('should not match entities from a different model', () => {
    const c: LensCriteria = { type: 'model', modelId: 'model-a' };
    expect(matchesCriteria(c, 3, createModelProvider())).toBe(false);
  });

  it('should return false when modelId is missing in criteria', () => {
    expect(matchesCriteria({ type: 'model' }, 1, createModelProvider())).toBe(false);
  });

  it('should return false when provider omits getModelId', () => {
    const c: LensCriteria = { type: 'model', modelId: 'model-a' };
    expect(matchesCriteria(c, 1, createModelProvider(false))).toBe(false);
  });
});

describe('matchesCriteria — material (#1366)', () => {
  // A layered wall: layer-set name from getMaterialName, individual materials
  // from getMaterialNames.
  const provider: LensDataProvider = {
    getEntityCount: () => 1,
    forEachEntity: (cb) => cb(1, 'm1'),
    getEntityType: () => 'IfcWall',
    getPropertyValue: () => undefined,
    getPropertySets: () => [],
    getMaterialName: () => 'Basic Wall: Ext - Gyp/Ins',
    getMaterialNames: () => ['Gypsum Board', 'Insulation'],
  };
  const rule = (materialName: string): LensCriteria => ({ type: 'material', materialName });

  it('matches an individual constituent material', () => {
    expect(matchesCriteria(rule('gypsum'), 1, provider)).toBe(true);
    expect(matchesCriteria(rule('insulation'), 1, provider)).toBe(true);
  });

  it('still matches the layer-set / single name (no regression for dropdown rules)', () => {
    expect(matchesCriteria(rule('Basic Wall'), 1, provider)).toBe(true);
  });

  it('does not match an unrelated material', () => {
    expect(matchesCriteria(rule('steel'), 1, provider)).toBe(false);
  });

  it('matches via getMaterialName when getMaterialNames is absent', () => {
    const single: LensDataProvider = { ...provider, getMaterialNames: undefined };
    expect(matchesCriteria(rule('Gyp/Ins'), 1, single)).toBe(true);
    expect(matchesCriteria(rule('brick'), 1, single)).toBe(false);
  });
});
