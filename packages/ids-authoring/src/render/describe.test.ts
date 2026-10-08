/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IDSFacet } from '@ifc-lite/ids';
import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../../test/corpus.js';
import { describeFacet } from './describe.js';

const fire: IDSFacet = {
  type: 'property',
  propertySet: { type: 'simpleValue', value: 'Pset_DoorCommon' },
  baseName: { type: 'simpleValue', value: 'FireRating' },
};
const door: IDSFacet = { type: 'entity', name: { type: 'simpleValue', value: 'IFCDOOR' } };

describe('describeFacet', () => {
  it('names the facet content in every locale', () => {
    for (const locale of ['en', 'de', 'fr'] as const) {
      const text = describeFacet(fire, 'requirements', 'required', locale);
      expect(text, locale).toContain('FireRating');
      expect(text, locale).toContain('Pset_DoorCommon');
      expect(describeFacet(door, 'applicability', undefined, locale)).toMatch(/IFCDOOR/i);
    }
    const [en, de, fr] = (['en', 'de', 'fr'] as const).map((l) => describeFacet(fire, 'requirements', 'required', l));
    expect(new Set([en, de, fr]).size).toBe(3);
  });

  it('distinguishes required, optional and prohibited requirements', () => {
    for (const locale of ['en', 'de', 'fr'] as const) {
      const texts = (['required', 'optional', 'prohibited'] as const).map((o) => describeFacet(fire, 'requirements', o, locale));
      expect(new Set(texts).size, locale).toBe(3);
    }
    // Sentences the service cannot negate are labelled with the localised optionality instead.
    expect(describeFacet(fire, 'requirements', 'prohibited', 'de')).toMatch(/^Verboten: /);
    expect(describeFacet(fire, 'requirements', 'optional', 'fr')).toMatch(/^Optionnel: /);
    expect(describeFacet(door, 'requirements', 'prohibited', 'en')).toMatch(/NOT/);
  });

  it('reads applicability as selection and requirements as obligation', () => {
    expect(describeFacet(fire, 'applicability')).not.toBe(describeFacet(fire, 'requirements'));
  });

  it('renders every facet of the conformance corpus without throwing or falling back to keys', () => {
    for (const { name, ids } of loadCorpus()) {
      for (const spec of ids.specifications) {
        for (const f of spec.applicability.facets) {
          for (const locale of ['en', 'de', 'fr'] as const) expect(describeFacet(f, 'applicability', undefined, locale), name).not.toMatch(/^(applicability|requirements)\./);
        }
        for (const r of spec.requirements) {
          for (const locale of ['en', 'de', 'fr'] as const) {
            const text = describeFacet(r.facet, 'requirements', r.optionality, locale);
            expect(text.length, name).toBeGreaterThan(3);
            expect(text, name).not.toMatch(/^(applicability|requirements)\./);
          }
        }
      }
    }
  });
});
