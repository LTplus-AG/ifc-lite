/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createMockAccessor } from './test-helpers.js';
import { checkEntityFacet, filterByEntityFacet } from './entity-facet.js';
import { checkAttributeFacet } from './attribute-facet.js';
import { checkPropertyFacet } from './property-facet.js';
import { checkClassificationFacet } from './classification-facet.js';
import { checkMaterialFacet } from './material-facet.js';
import { checkPartOfFacet } from './partof-facet.js';
import type {
  IDSEntityFacet,
  IDSAttributeFacet,
  IDSPropertyFacet,
  IDSClassificationFacet,
  IDSMaterialFacet,
  IDSPartOfFacet,
  IDSSimpleValue,
  IDSConstraint,
} from '../types.js';

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });

// ============================================================================
// Entity Facet
// ============================================================================

describe('checkEntityFacet', () => {
  const accessor = createMockAccessor([
    { expressId: 1, type: 'IfcWall', objectType: 'STANDARD' },
    { expressId: 2, type: 'IfcSlab' },
    { expressId: 3, type: 'IfcWall', objectType: 'SHEAR' },
  ]);

  it('passes when entity type matches', () => {
    const facet: IDSEntityFacet = { type: 'entity', name: sv('IFCWALL') };
    const result = checkEntityFacet(facet, 1, accessor);
    expect(result.passed).toBe(true);
  });

  it('fails when entity type does not match', () => {
    const facet: IDSEntityFacet = { type: 'entity', name: sv('IFCBEAM') };
    const result = checkEntityFacet(facet, 1, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('ENTITY_TYPE_MISMATCH');
  });

  it('fails for unknown entity', () => {
    const facet: IDSEntityFacet = { type: 'entity', name: sv('IFCWALL') };
    const result = checkEntityFacet(facet, 999, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('ENTITY_TYPE_MISMATCH');
  });

  it('passes with matching predefined type', () => {
    const facet: IDSEntityFacet = {
      type: 'entity',
      name: sv('IFCWALL'),
      predefinedType: sv('STANDARD'),
    };
    const result = checkEntityFacet(facet, 1, accessor);
    expect(result.passed).toBe(true);
  });

  it('fails when predefined type does not match', () => {
    const facet: IDSEntityFacet = {
      type: 'entity',
      name: sv('IFCWALL'),
      predefinedType: sv('CURTAIN'),
    };
    const result = checkEntityFacet(facet, 1, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PREDEFINED_TYPE_MISMATCH');
  });

  it('fails when predefined type is missing on entity', () => {
    const facet: IDSEntityFacet = {
      type: 'entity',
      name: sv('IFCSLAB'),
      predefinedType: sv('FLOOR'),
    };
    const result = checkEntityFacet(facet, 2, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PREDEFINED_TYPE_MISSING');
  });
});

describe('filterByEntityFacet', () => {
  const accessor = createMockAccessor([
    { expressId: 1, type: 'IfcWall' },
    { expressId: 2, type: 'IfcWall' },
    { expressId: 3, type: 'IfcSlab' },
  ]);

  it('filters by simpleValue type name', () => {
    const facet: IDSEntityFacet = { type: 'entity', name: sv('IfcWall') };
    const ids = filterByEntityFacet(facet, accessor);
    expect(ids).toEqual([1, 2]);
  });

  it('filters by enumeration type names', () => {
    const facet: IDSEntityFacet = {
      type: 'entity',
      name: { type: 'enumeration', values: ['IfcWall', 'IfcSlab'] },
    };
    const ids = filterByEntityFacet(facet, accessor);
    expect(ids).toEqual([1, 2, 3]);
  });

  it('returns undefined for pattern (needs full scan)', () => {
    const facet: IDSEntityFacet = {
      type: 'entity',
      name: { type: 'pattern', pattern: 'Ifc.*' },
    };
    const ids = filterByEntityFacet(facet, accessor);
    expect(ids).toBeUndefined();
  });
});

// ============================================================================
// Attribute Facet
// ============================================================================

describe('checkAttributeFacet', () => {
  const accessor = createMockAccessor([
    {
      expressId: 1,
      type: 'IfcWall',
      name: 'Wall_001',
      description: 'Exterior wall',
      globalId: '2hJPBR_uf8qhEjxMvzJXOP',
      objectType: 'STANDARD',
    },
    { expressId: 2, type: 'IfcSlab' },
    {
      expressId: 3,
      type: 'IfcWall',
      name: 'Wall_002',
      attributes: { Tag: 'W-002', LongName: 'My Long Wall' },
    },
  ]);

  it('passes when attribute exists (existence check only)', () => {
    const facet: IDSAttributeFacet = { type: 'attribute', name: sv('Name') };
    const result = checkAttributeFacet(facet, 1, accessor);
    expect(result.passed).toBe(true);
    expect(result.actualValue).toBe('Wall_001');
  });

  it('fails when attribute is missing', () => {
    const facet: IDSAttributeFacet = { type: 'attribute', name: sv('Name') };
    const result = checkAttributeFacet(facet, 2, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('ATTRIBUTE_MISSING');
  });

  it('passes when attribute value matches', () => {
    const facet: IDSAttributeFacet = {
      type: 'attribute',
      name: sv('Name'),
      value: sv('Wall_001'),
    };
    const result = checkAttributeFacet(facet, 1, accessor);
    expect(result.passed).toBe(true);
  });

  it('fails when attribute value does not match', () => {
    const facet: IDSAttributeFacet = {
      type: 'attribute',
      name: sv('Name'),
      value: sv('WrongName'),
    };
    const result = checkAttributeFacet(facet, 1, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('ATTRIBUTE_VALUE_MISMATCH');
  });

  it('uses generic getAttribute for non-standard attributes', () => {
    const facet: IDSAttributeFacet = {
      type: 'attribute',
      name: sv('Tag'),
      value: sv('W-002'),
    };
    const result = checkAttributeFacet(facet, 3, accessor);
    expect(result.passed).toBe(true);
  });

  it('supports pattern constraint on attribute value', () => {
    const facet: IDSAttributeFacet = {
      type: 'attribute',
      name: sv('Name'),
      value: { type: 'pattern', pattern: 'Wall_.*' },
    };
    const result = checkAttributeFacet(facet, 1, accessor);
    expect(result.passed).toBe(true);
  });

  it('returns ATTRIBUTE_PATTERN_MISMATCH for pattern mismatch', () => {
    const facet: IDSAttributeFacet = {
      type: 'attribute',
      name: sv('Name'),
      value: { type: 'pattern', pattern: 'Slab_.*' },
    };
    const result = checkAttributeFacet(facet, 1, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('ATTRIBUTE_PATTERN_MISMATCH');
  });

  it('handles pattern constraint on attribute name', () => {
    // Pattern matching on which attribute to check
    const facet: IDSAttributeFacet = {
      type: 'attribute',
      name: { type: 'pattern', pattern: 'N.*' },
    };
    const result = checkAttributeFacet(facet, 1, accessor);
    expect(result.passed).toBe(true);
  });

  it('fails when no standard attribute matches the name pattern', () => {
    const facet: IDSAttributeFacet = {
      type: 'attribute',
      name: { type: 'pattern', pattern: 'ZZZ.*' },
    };
    const result = checkAttributeFacet(facet, 1, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('ATTRIBUTE_MISSING');
  });

  it('checks all matching attributes for pattern name (not just first)', () => {
    // Entity 1 has Name and Description — pattern ".*tion" matches Description only
    // Entity 1 has description 'Exterior wall', which exists → should pass existence check
    const facet: IDSAttributeFacet = {
      type: 'attribute',
      name: { type: 'pattern', pattern: 'Desc.*' },
    };
    const result = checkAttributeFacet(facet, 1, accessor);
    expect(result.passed).toBe(true);
    expect(result.actualValue).toBe('Exterior wall');
  });

  it('returns value mismatch over attribute missing when pattern name matches multiple attrs', () => {
    // Create an accessor where Name exists but Description is missing
    const partialAccessor = createMockAccessor([
      { expressId: 10, type: 'IfcWall', name: 'W1' }, // has Name, no Description
    ]);
    // Pattern matches both 'Name' and ... nothing else starting with 'N'
    // Use enumeration to check multiple: Name + Description
    const facet: IDSAttributeFacet = {
      type: 'attribute',
      name: { type: 'enumeration', values: ['Name', 'Description'] },
      value: sv('W1'),
    };
    const result = checkAttributeFacet(facet, 10, partialAccessor);
    // Name='W1' matches value constraint 'W1' → should pass
    expect(result.passed).toBe(true);
    expect(result.actualValue).toBe('W1');
  });

  it('returns most specific failure across multiple attribute candidates', () => {
    // Entity has Name='Wall_001' but Description is missing
    // Checking enumeration [Name, Description] with value constraint 'WRONG'
    const facet: IDSAttributeFacet = {
      type: 'attribute',
      name: { type: 'enumeration', values: ['Name', 'Description'] },
      value: sv('WRONG'),
    };
    const result = checkAttributeFacet(facet, 1, accessor);
    expect(result.passed).toBe(false);
    // Name exists but value doesn't match → VALUE_MISMATCH (more specific than Description's MISSING)
    expect(result.failure?.type).toBe('ATTRIBUTE_VALUE_MISMATCH');
    expect(result.failure?.actual).toBe('Wall_001');
  });
});

// ============================================================================
// Property Facet
// ============================================================================

describe('checkPropertyFacet', () => {
  const accessor = createMockAccessor([
    {
      expressId: 1,
      type: 'IfcWall',
      properties: [
        { psetName: 'Pset_WallCommon', propName: 'IsExternal', value: true, dataType: 'IFCBOOLEAN' },
        { psetName: 'Pset_WallCommon', propName: 'FireRating', value: 'REI60', dataType: 'IFCLABEL' },
        { psetName: 'Pset_WallCommon', propName: 'ThermalTransmittance', value: 0.25, dataType: 'IFCREAL' },
      ],
    },
    { expressId: 2, type: 'IfcSlab' }, // no properties at all
    {
      expressId: 3,
      type: 'IfcBeam',
      properties: [
        { psetName: 'Pset_BeamCommon', propName: 'Span', value: 6.0, dataType: 'IFCREAL' },
      ],
    },
  ]);

  it('passes when property exists (no value constraint)', () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: sv('Pset_WallCommon'),
      baseName: sv('IsExternal'),
    };
    const result = checkPropertyFacet(facet, 1, accessor);
    expect(result.passed).toBe(true);
  });

  it('fails when entity has no property sets', () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: sv('Pset_WallCommon'),
      baseName: sv('IsExternal'),
    };
    const result = checkPropertyFacet(facet, 2, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PSET_MISSING');
  });

  it('fails when property set does not match', () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: sv('Pset_SlabCommon'),
      baseName: sv('IsExternal'),
    };
    const result = checkPropertyFacet(facet, 1, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PSET_MISSING');
  });

  it('fails when property is missing from matching pset', () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: sv('Pset_WallCommon'),
      baseName: sv('LoadBearing'),
    };
    const result = checkPropertyFacet(facet, 1, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PROPERTY_MISSING');
  });

  it('passes when property value matches', () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: sv('Pset_WallCommon'),
      baseName: sv('FireRating'),
      value: sv('REI60'),
    };
    const result = checkPropertyFacet(facet, 1, accessor);
    expect(result.passed).toBe(true);
  });

  it('fails when property value does not match', () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: sv('Pset_WallCommon'),
      baseName: sv('FireRating'),
      value: sv('REI120'),
    };
    const result = checkPropertyFacet(facet, 1, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PROPERTY_VALUE_MISMATCH');
  });

  it('passes when data type matches', () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: sv('Pset_WallCommon'),
      baseName: sv('FireRating'),
      dataType: sv('IFCLABEL'),
    };
    const result = checkPropertyFacet(facet, 1, accessor);
    expect(result.passed).toBe(true);
  });

  it('fails when data type does not match', () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: sv('Pset_WallCommon'),
      baseName: sv('FireRating'),
      dataType: sv('IFCREAL'),
    };
    const result = checkPropertyFacet(facet, 1, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PROPERTY_DATATYPE_MISMATCH');
  });

  it('passes bounds check on numeric property', () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: sv('Pset_WallCommon'),
      baseName: sv('ThermalTransmittance'),
      value: { type: 'bounds', minInclusive: 0, maxInclusive: 1.0 },
    };
    const result = checkPropertyFacet(facet, 1, accessor);
    expect(result.passed).toBe(true);
  });

  it('fails bounds check when out of range', () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: sv('Pset_WallCommon'),
      baseName: sv('ThermalTransmittance'),
      value: { type: 'bounds', maxExclusive: 0.2 },
    };
    const result = checkPropertyFacet(facet, 1, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PROPERTY_OUT_OF_BOUNDS');
  });

  it('requires ALL matching properties to satisfy value (not just first)', () => {
    // Per IDS spec — when baseName is a pattern that matches multiple
    // properties, every match must satisfy the value constraint.
    // Mirrors buildingSMART fixture
    // `property/fail-all_matching_properties_must_satisfy_requirements_3_3`.
    const multiPropAccessor = createMockAccessor([
      {
        expressId: 20,
        type: 'IfcWall',
        properties: [
          { psetName: 'Custom', propName: 'Rating_A', value: 'LOW', dataType: 'IFCLABEL' },
          { psetName: 'Custom', propName: 'Rating_B', value: 'HIGH', dataType: 'IFCLABEL' },
        ],
      },
    ]);
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: sv('Custom'),
      baseName: { type: 'pattern', pattern: 'Rating_.*' },
      value: sv('HIGH'),
    };
    // Rating_A=LOW fails the value constraint → spec-level fail.
    const result = checkPropertyFacet(facet, 20, multiPropAccessor);
    expect(result.passed).toBe(false);

    // Sanity check: when every matching property satisfies the value,
    // we get a pass.
    const allMatchAccessor = createMockAccessor([
      {
        expressId: 20,
        type: 'IfcWall',
        properties: [
          { psetName: 'Custom', propName: 'Rating_A', value: 'HIGH', dataType: 'IFCLABEL' },
          { psetName: 'Custom', propName: 'Rating_B', value: 'HIGH', dataType: 'IFCLABEL' },
        ],
      },
    ]);
    expect(checkPropertyFacet(facet, 20, allMatchAccessor).passed).toBe(true);
  });

  it('returns value mismatch (not property missing) when property found but value wrong', () => {
    // Single matching property, value doesn't match
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: sv('Pset_WallCommon'),
      baseName: sv('IsExternal'),
      value: sv('false'),
    };
    const result = checkPropertyFacet(facet, 1, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PROPERTY_VALUE_MISMATCH');
  });

  it('handles null property value', () => {
    const accessorWithNull = createMockAccessor([
      {
        expressId: 10,
        type: 'IfcWall',
        properties: [
          { psetName: 'Pset_WallCommon', propName: 'FireRating', value: null, dataType: 'IFCLABEL' },
        ],
      },
    ]);
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: sv('Pset_WallCommon'),
      baseName: sv('FireRating'),
      value: sv('REI60'),
    };
    const result = checkPropertyFacet(facet, 10, accessorWithNull);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PROPERTY_VALUE_MISMATCH');
  });
});

// ============================================================================
// Classification Facet
// ============================================================================

describe('checkClassificationFacet', () => {
  const accessor = createMockAccessor([
    {
      expressId: 1,
      type: 'IfcWall',
      classifications: [
        { system: 'Uniclass', value: 'EF_25_10' },
        { system: 'OmniClass', value: '21-02 10 10' },
      ],
    },
    { expressId: 2, type: 'IfcSlab' }, // no classifications
    {
      expressId: 3,
      type: 'IfcBeam',
      classifications: [{ system: 'Uniclass', value: 'EF_25_30' }],
    },
  ]);

  it('passes when any classification exists (no constraints)', () => {
    const facet: IDSClassificationFacet = { type: 'classification' };
    const result = checkClassificationFacet(facet, 1, accessor);
    expect(result.passed).toBe(true);
  });

  it('fails when no classification exists', () => {
    const facet: IDSClassificationFacet = { type: 'classification' };
    const result = checkClassificationFacet(facet, 2, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('CLASSIFICATION_MISSING');
  });

  it('passes when system matches', () => {
    const facet: IDSClassificationFacet = {
      type: 'classification',
      system: sv('Uniclass'),
    };
    const result = checkClassificationFacet(facet, 1, accessor);
    expect(result.passed).toBe(true);
  });

  it('fails when system does not match', () => {
    const facet: IDSClassificationFacet = {
      type: 'classification',
      system: sv('MasterFormat'),
    };
    const result = checkClassificationFacet(facet, 1, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('CLASSIFICATION_SYSTEM_MISMATCH');
  });

  it('passes when system and value both match', () => {
    const facet: IDSClassificationFacet = {
      type: 'classification',
      system: sv('Uniclass'),
      value: sv('EF_25_10'),
    };
    const result = checkClassificationFacet(facet, 1, accessor);
    expect(result.passed).toBe(true);
  });

  it('fails when system matches but value does not', () => {
    const facet: IDSClassificationFacet = {
      type: 'classification',
      system: sv('Uniclass'),
      value: sv('EF_99_99'),
    };
    const result = checkClassificationFacet(facet, 1, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('CLASSIFICATION_VALUE_MISMATCH');
  });

  it('passes with value-only constraint', () => {
    const facet: IDSClassificationFacet = {
      type: 'classification',
      value: sv('EF_25_10'),
    };
    const result = checkClassificationFacet(facet, 1, accessor);
    expect(result.passed).toBe(true);
  });

  it('fails with value-only constraint when no value matches', () => {
    const facet: IDSClassificationFacet = {
      type: 'classification',
      value: sv('XX_YY_ZZ'),
    };
    const result = checkClassificationFacet(facet, 1, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('CLASSIFICATION_VALUE_MISMATCH');
  });

  it('returns CLASSIFICATION_MISSING when entity has no classifications (with system constraint)', () => {
    const facet: IDSClassificationFacet = {
      type: 'classification',
      system: sv('Uniclass'),
    };
    const result = checkClassificationFacet(facet, 2, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('CLASSIFICATION_MISSING');
    expect(result.actualValue).toBe('(none)');
  });

  it('returns CLASSIFICATION_MISSING when entity has no classifications (with value constraint)', () => {
    const facet: IDSClassificationFacet = {
      type: 'classification',
      value: sv('EF_25_10'),
    };
    const result = checkClassificationFacet(facet, 2, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('CLASSIFICATION_MISSING');
    expect(result.actualValue).toBe('(none)');
  });

  it('returns CLASSIFICATION_MISSING when entity has no classifications (with system + value constraint)', () => {
    const facet: IDSClassificationFacet = {
      type: 'classification',
      system: sv('Uniclass'),
      value: sv('EF_25_10'),
    };
    const result = checkClassificationFacet(facet, 2, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('CLASSIFICATION_MISSING');
    expect(result.actualValue).toBe('(none)');
  });
});

// ============================================================================
// Material Facet
// ============================================================================

describe('checkMaterialFacet', () => {
  const accessor = createMockAccessor([
    {
      expressId: 1,
      type: 'IfcWall',
      materials: [
        { name: 'Concrete', category: 'Structural' },
        { name: 'Insulation' },
      ],
    },
    { expressId: 2, type: 'IfcSlab' }, // no materials
    {
      expressId: 3,
      type: 'IfcBeam',
      materials: [{ name: 'Steel', category: 'Structural' }],
    },
  ]);

  it('passes when any material exists (no value constraint)', () => {
    const facet: IDSMaterialFacet = { type: 'material' };
    const result = checkMaterialFacet(facet, 1, accessor);
    expect(result.passed).toBe(true);
  });

  it('fails when no material is assigned', () => {
    const facet: IDSMaterialFacet = { type: 'material' };
    const result = checkMaterialFacet(facet, 2, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('MATERIAL_MISSING');
  });

  it('passes when material name matches value constraint', () => {
    const facet: IDSMaterialFacet = { type: 'material', value: sv('Concrete') };
    const result = checkMaterialFacet(facet, 1, accessor);
    expect(result.passed).toBe(true);
  });

  it('passes when material category matches value constraint', () => {
    const facet: IDSMaterialFacet = { type: 'material', value: sv('Structural') };
    const result = checkMaterialFacet(facet, 1, accessor);
    expect(result.passed).toBe(true);
  });

  it('fails when no material matches value constraint', () => {
    const facet: IDSMaterialFacet = { type: 'material', value: sv('Wood') };
    const result = checkMaterialFacet(facet, 1, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('MATERIAL_VALUE_MISMATCH');
  });

  it('returns MATERIAL_MISSING when value constraint present but no materials', () => {
    const facet: IDSMaterialFacet = { type: 'material', value: sv('Concrete') };
    const result = checkMaterialFacet(facet, 2, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('MATERIAL_MISSING');
  });

  it('matches material with pattern constraint', () => {
    const facet: IDSMaterialFacet = {
      type: 'material',
      value: { type: 'pattern', pattern: 'Con.*' },
    };
    const result = checkMaterialFacet(facet, 1, accessor);
    expect(result.passed).toBe(true);
  });
});

// ============================================================================
// PartOf Facet
// ============================================================================

describe('checkPartOfFacet', () => {
  const accessor = createMockAccessor([
    {
      expressId: 1,
      type: 'IfcWall',
      parent: {
        expressId: 100,
        type: 'IfcBuildingStorey',
        relation: 'IfcRelContainedInSpatialStructure',
      },
    },
    { expressId: 2, type: 'IfcSlab' }, // no parent
    {
      expressId: 3,
      type: 'IfcWindow',
      parent: {
        expressId: 200,
        type: 'IfcWall',
        relation: 'IfcRelFillsElement',
        predefinedType: 'STANDARD',
      },
    },
    {
      expressId: 4,
      type: 'IfcBeam',
      parent: {
        expressId: 300,
        type: 'IfcBuilding',
        relation: 'IfcRelAggregates',
      },
    },
  ]);

  it('passes when parent exists via specified relation', () => {
    const facet: IDSPartOfFacet = {
      type: 'partOf',
      relation: 'IfcRelContainedInSpatialStructure',
    };
    const result = checkPartOfFacet(facet, 1, accessor);
    expect(result.passed).toBe(true);
  });

  it('fails when no parent exists', () => {
    const facet: IDSPartOfFacet = {
      type: 'partOf',
      relation: 'IfcRelContainedInSpatialStructure',
    };
    const result = checkPartOfFacet(facet, 2, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PARTOF_RELATION_MISSING');
  });

  it('fails when relation type does not match', () => {
    const facet: IDSPartOfFacet = {
      type: 'partOf',
      relation: 'IfcRelAggregates',
    };
    // entity 1 has IfcRelContainedInSpatialStructure, not IfcRelAggregates
    const result = checkPartOfFacet(facet, 1, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PARTOF_RELATION_MISSING');
  });

  it('passes when parent entity type matches constraint', () => {
    const facet: IDSPartOfFacet = {
      type: 'partOf',
      relation: 'IfcRelContainedInSpatialStructure',
      entity: { type: 'entity', name: sv('IfcBuildingStorey') },
    };
    const result = checkPartOfFacet(facet, 1, accessor);
    expect(result.passed).toBe(true);
  });

  it('fails when parent entity type does not match constraint', () => {
    const facet: IDSPartOfFacet = {
      type: 'partOf',
      relation: 'IfcRelContainedInSpatialStructure',
      entity: { type: 'entity', name: sv('IfcBuilding') },
    };
    const result = checkPartOfFacet(facet, 1, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PARTOF_ENTITY_MISMATCH');
  });

  it('passes when parent entity type and predefined type match', () => {
    const facet: IDSPartOfFacet = {
      type: 'partOf',
      relation: 'IfcRelFillsElement',
      entity: {
        type: 'entity',
        name: sv('IfcWall'),
        predefinedType: sv('STANDARD'),
      },
    };
    const result = checkPartOfFacet(facet, 3, accessor);
    expect(result.passed).toBe(true);
  });

  it('fails when parent predefined type does not match', () => {
    const facet: IDSPartOfFacet = {
      type: 'partOf',
      relation: 'IfcRelFillsElement',
      entity: {
        type: 'entity',
        name: sv('IfcWall'),
        predefinedType: sv('CURTAIN'),
      },
    };
    const result = checkPartOfFacet(facet, 3, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PARTOF_PREDEFINED_TYPE_MISMATCH');
    expect(result.failure?.actual).toBe('STANDARD');
    expect(result.failure?.expected).toContain('CURTAIN');
  });

  it('fails when parent has no predefined type but one is required', () => {
    const facet: IDSPartOfFacet = {
      type: 'partOf',
      relation: 'IfcRelAggregates',
      entity: {
        type: 'entity',
        name: sv('IfcBuilding'),
        predefinedType: sv('COMPLEX'),
      },
    };
    const result = checkPartOfFacet(facet, 4, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PARTOF_PREDEFINED_TYPE_MISSING');
    expect(result.failure?.field).toBe('predefinedType');
  });
});

