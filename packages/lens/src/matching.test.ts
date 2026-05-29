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
