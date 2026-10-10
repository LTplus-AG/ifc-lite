/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every shipped locale is a complete catalogue (IDS-011 added Italian): the
 * same keys as English, the same `{placeholders}` in every string (a dropped
 * or misspelt placeholder renders the raw `{name}` to the user), and no
 * string left empty. The Italian rendering of a representative report is
 * pinned in a snapshot so a catalogue edit shows up in review.
 */

import { describe, expect, it } from 'vitest';
import { en, de, fr, it as itLocale } from './locales/index.js';
import { createTranslationService } from './index.js';
import type { IDSRequirement, SupportedLocale } from '../types.js';

type Tree = { readonly [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of leaves(value, path)) out.set(k, v);
  }
  return out;
}

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const LOCALES: Record<Exclude<SupportedLocale, 'en'>, Tree> = { de, fr, it: itLocale };

describe('translation catalogues are complete', () => {
  const reference = leaves(en);
  for (const [locale, catalogue] of Object.entries(LOCALES)) {
    it(`${locale} has every English key, the same placeholders and no empty string`, () => {
      const own = leaves(catalogue);
      expect([...own.keys()].sort()).toEqual([...reference.keys()].sort());
      const drift = [...reference].filter(([key, text]) => placeholders(own.get(key) ?? '').join() !== placeholders(text).join());
      expect(drift.map(([key]) => key)).toEqual([]);
      expect([...own].filter(([, text]) => text.trim() === '').map(([key]) => key)).toEqual([]);
    });
  }

  it('createTranslationService("it") renders Italian descriptions (snapshot)', () => {
    const t = createTranslationService('it');
    expect(t.locale).toBe('it');
    const requirement: IDSRequirement = {
      id: 'r', optionality: 'required',
      facet: { type: 'property', propertySet: { type: 'simpleValue', value: 'Pset_WallCommon' }, baseName: { type: 'simpleValue', value: 'FireRating' },
        value: { type: 'enumeration', values: ['EI60', 'EI90'] } },
    };
    expect({
      status: t.getStatusText('fail'),
      optionality: t.getOptionalityText('prohibited'),
      requirement: t.describeRequirement(requirement),
      bounds: t.describeConstraint({ type: 'bounds', minInclusive: 0, maxInclusive: 2.5 }),
      summary: t.t('summary.entities', { passed: 3, total: 4, percent: 75 }),
    }).toMatchInlineSnapshot(`
      {
        "bounds": "tra 0 e 2.5",
        "optionality": "Vietato",
        "requirement": "La proprietà ""Pset_WallCommon"."FireRating"" deve essere uguale a uno tra ["EI60", "EI90"]",
        "status": "NON CONFORME",
        "summary": "3/4 elementi conformi (75%)",
      }
    `);
  });
});
