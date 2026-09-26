/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Adversarial review of #6153 caught that `describeFailure` folded the new
 * `PROPERTY_EMPTY` failure type (added for #6117) into the
 * `PROPERTY_VALUE_MISMATCH` case, which interpolates `actual`/`expected` —
 * fields `PROPERTY_EMPTY` never sets — so every translated empty-value
 * message rendered as `Property "P.N" is "(empty)", expected Z` instead of
 * using the dedicated `propertyEmpty` catalogue string in en/de/fr, which
 * had been sitting unreferenced. This pins the fixed dispatch across all
 * three shipped locales, and pins that the fallthrough text is gone.
 */

import { describe, it, expect } from 'vitest';
import { checkPropertyFacet } from '../facets/property-facet.js';
import { createMockAccessor } from '../facets/test-helpers.js';
import { createTranslationService } from './index.js';
import type { IDSPropertyFacet, IDSRequirementResult, IDSSimpleValue } from '../types.js';

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });

const accessor = createMockAccessor([
  {
    expressId: 1,
    type: 'IfcWall',
    properties: [{ psetName: 'Foo_Bar', propName: 'Empty', value: '', dataType: 'IFCLABEL' }],
  },
]);

const facet: IDSPropertyFacet = {
  type: 'property',
  propertySet: sv('Foo_Bar'),
  baseName: sv('Empty'),
};

describe('PROPERTY_EMPTY translated message (#6153 review)', () => {
  const result = checkPropertyFacet(facet, 1, accessor);
  it('is a PROPERTY_EMPTY failure (precondition)', () => {
    expect(result.failure?.type).toBe('PROPERTY_EMPTY');
  });

  const expected: Record<'en' | 'de' | 'fr', string> = {
    en: 'Property "Foo_Bar.Empty" has no value',
    de: 'Eigenschaft "Foo_Bar.Empty" hat keinen Wert',
    fr: 'La propriété "Foo_Bar.Empty" n\'a pas de valeur',
  };

  for (const locale of ['en', 'de', 'fr'] as const) {
    it(`describeFailure (${locale}) uses the dedicated propertyEmpty string, not the value-mismatch fallthrough`, () => {
      const translator = createTranslationService(locale);
      const message = translator.describeFailure({ failure: result.failure } as unknown as IDSRequirementResult);
      expect(message).toBe(expected[locale]);
      // The fallthrough this bug produced always contains "(empty)" as the
      // interpolated `actual` value inside the mismatch template.
      expect(message).not.toContain('(empty)');
    });
  }
});
