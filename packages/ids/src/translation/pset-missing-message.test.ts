/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8306: when an entity had property sets but none matched the facet's
 * `propertySet`, the checker put the literal key `'propertySet'` in
 * `failure.field`, so every message said `Property set "propertySet" not
 * found`. Fixing that exposed the wider class: constraint renderings carry
 * their own quotes (`"X"`, `pattern "X"`), and the templates quoted them
 * again (`""X""`, `""Pset"."Prop""`). Templates now leave constraint slots
 * bare, and an exact property path renders as one quoted `"Pset.Prop"`.
 */

import { describe, it, expect } from 'vitest';
import { checkAttributeFacet } from '../facets/attribute-facet.js';
import { checkClassificationFacet } from '../facets/classification-facet.js';
import { checkPropertyFacet } from '../facets/property-facet.js';
import { createMockAccessor } from '../facets/test-helpers.js';
import type { FacetCheckResult } from '../facets/index.js';
import { formatFailureReason, formatRequirementDescription } from '../validation/format-failure-reason.js';
import { createTranslationService } from './index.js';
import type { IDSConstraint, IDSFacet, IDSPropertyFacet, IDSRequirementResult, SupportedLocale } from '../types.js';

const sv = (value: string): IDSConstraint => ({ type: 'simpleValue', value });
const LOCALES: SupportedLocale[] = ['en', 'de', 'fr', 'it', 'ru'];
// A constraint quoted twice, or two quoted names joined by a dot.
const DOUBLED = /""|"\."/;

const accessor = createMockAccessor([
  {
    expressId: 1,
    type: 'IfcWall',
    name: 'Wall',
    properties: [
      { psetName: 'Pset_WallCommon', propName: 'IsExternal', value: true, dataType: 'IFCBOOLEAN' },
      { psetName: 'Pset_EnvironmentalImpactIndicators', propName: 'Reference', value: 'X', dataType: 'IFCLABEL' },
    ],
    classifications: [{ system: 'Uniclass', value: 'EF_25_10' }],
  },
  { expressId: 2, type: 'IfcWall' },
]);

const describeFailure = (result: FacetCheckResult, locale: SupportedLocale = 'en') =>
  createTranslationService(locale).describeFailure({ failure: result.failure } as unknown as IDSRequirementResult);

const psetFacet = (propertySet: IDSConstraint): IDSPropertyFacet => ({
  type: 'property',
  propertySet,
  baseName: sv('IsExternal'),
});

describe('PSET_MISSING names the required property set (#8306)', () => {
  const available = 'Available: Pset_WallCommon, Pset_EnvironmentalImpactIndicators';
  const cases: Array<{ label: string; constraint: IDSConstraint; shown: string }> = [
    { label: 'simple value', constraint: sv('Pset_RequiredExample'), shown: '"Pset_RequiredExample"' },
    { label: 'pattern', constraint: { type: 'pattern', pattern: 'Pset_Required.*' }, shown: 'pattern "Pset_Required.*"' },
    { label: 'enumeration', constraint: { type: 'enumeration', values: ['Pset_A', 'Pset_B'] }, shown: 'one of ["Pset_A", "Pset_B"]' },
  ];

  for (const { label, constraint, shown } of cases) {
    it(`entity with non-matching sets: ${label}`, () => {
      const result = checkPropertyFacet(psetFacet(constraint), 1, accessor);
      expect(result.failure?.type).toBe('PSET_MISSING');
      expect(result.failure?.field).toBe(constraint.type === 'simpleValue' ? 'Pset_RequiredExample' : shown);
      expect(describeFailure(result)).toBe(`Property set ${shown} not found. ${available}`);
      expect(formatFailureReason(result)).toBe(`Property set ${shown} not found`);
    });

    it(`entity with no sets: ${label}`, () => {
      const result = checkPropertyFacet(psetFacet(constraint), 2, accessor);
      expect(result.failure?.type).toBe('PSET_MISSING');
      expect(describeFailure(result)).toBe(`Property set ${shown} not found`);
      expect(formatFailureReason(result)).toBe(`Property set ${shown} not found`);
    });
  }
});

describe('constraint names are quoted once in every message (#8306)', () => {
  const failures: Array<[string, FacetCheckResult, string]> = [
    ['PROPERTY_MISSING', checkPropertyFacet({ type: 'property', propertySet: sv('Pset_WallCommon'), baseName: sv('FireRating') }, 1, accessor),
      'Property "FireRating" not found in "Pset_WallCommon". Available: Pset_WallCommon.IsExternal'],
    ['ATTRIBUTE_MISSING (no attribute matches)', checkAttributeFacet({ type: 'attribute', name: { type: 'pattern', pattern: 'Foo.*' } }, 1, accessor),
      'Attribute pattern "Foo.*" does not exist'],
    ['ATTRIBUTE_MISSING (attribute unset)', checkAttributeFacet({ type: 'attribute', name: sv('Description') }, 1, accessor),
      'Attribute "Description" does not exist'],
    ['CLASSIFICATION_SYSTEM_MISMATCH', checkClassificationFacet({ type: 'classification', system: sv('OmniClass') }, 1, accessor),
      'Classification system "OmniClass" not found. Available: Uniclass'],
  ];

  for (const [label, result, en] of failures) {
    it(`${label}: describeFailure`, () => {
      expect(describeFailure(result)).toBe(en);
      // `field` stays the bare name the evidence and corrections read.
      expect(result.failure?.field).not.toMatch(/^"/);
      for (const locale of LOCALES) expect(describeFailure(result, locale)).not.toMatch(DOUBLED);
      expect(formatFailureReason(result)).not.toMatch(DOUBLED);
    });
  }

  const requirements: Array<[IDSFacet, string]> = [
    [{ type: 'attribute', name: sv('Name') }, 'Attribute "Name" must exist'],
    [{ type: 'attribute', name: sv('Name'), value: sv('Wall') }, 'Attribute "Name" must equal "Wall"'],
    [{ type: 'property', propertySet: sv('Pset_WallCommon'), baseName: sv('FireRating') }, 'Property "Pset_WallCommon.FireRating" must exist'],
    [{ type: 'property', propertySet: { type: 'pattern', pattern: 'Pset_.*' }, baseName: sv('FireRating'), value: sv('EI60') },
      'Property matching pattern "Pset_.*"."FireRating" must equal "EI60"'],
    [{ type: 'classification', system: sv('Uniclass'), value: sv('EF_25_10') }, 'Must be classified as "EF_25_10" in "Uniclass"'],
    [{ type: 'material', value: sv('Concrete') }, 'Must have material "Concrete"'],
  ];

  for (const [facet, en] of requirements) {
    it(`describeRequirement: ${en}`, () => {
      const requirement = { id: 'r', optionality: 'required' as const, facet };
      expect(createTranslationService('en').describeRequirement(requirement)).toBe(en);
      expect(createTranslationService('en').describeFacet(facet, 'applicability')).not.toMatch(/""/);
      for (const locale of LOCALES) {
        expect(createTranslationService(locale).describeRequirement(requirement)).not.toMatch(/""/);
      }
      expect(formatRequirementDescription(requirement)).not.toMatch(/""/);
    });
  }

  it('t() still renders raw pset + property callers on the {path} templates', () => {
    expect(createTranslationService('en').t('requirements.property.mustNotExist', { pset: 'Pset_WallCommon', property: 'FireRating' }))
      .toBe('Property "Pset_WallCommon.FireRating" must not exist');
    expect(createTranslationService('en').t('requirements.property.mustExist', { path: '"P.N"', pset: 'x', property: 'y' }))
      .toBe('Property "P.N" must exist');
  });

  it('an exact property path is one quoted name in every locale', () => {
    const requirement = { id: 'r', optionality: 'required' as const, facet: { type: 'property', propertySet: sv('Pset_WallCommon'), baseName: sv('FireRating') } as IDSFacet };
    for (const locale of LOCALES) {
      expect(createTranslationService(locale).describeRequirement(requirement)).toContain('"Pset_WallCommon.FireRating"');
    }
    expect(formatRequirementDescription(requirement)).toBe('Property "Pset_WallCommon.FireRating" must exist');
  });
});
