/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8306: the service renders from a copy of each locale catalogue with its
 * constraint slots unquoted. The adjustment is a text match on `"{slot}"`,
 * so a locale that quoted a slot differently would silently keep doubling.
 * This pins that every listed slot and property path is adjusted in every
 * locale, and that the exported catalogues are left as they were.
 */

import { describe, it, expect } from 'vitest';
import { en, de, fr, it as itLocale, ru } from './locales/index.js';
import { PATH_GROUPS, SELF_QUOTED_SLOTS, selfQuotedCatalogue } from './self-quoted.js';

const LOCALES = { en, de, fr, it: itLocale, ru };

function entries(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]];
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([k, v]) => entries(v, prefix ? `${prefix}.${k}` : k));
}

describe('selfQuotedCatalogue (#8306)', () => {
  for (const [locale, catalogue] of Object.entries(LOCALES)) {
    const adjusted = new Map(entries(selfQuotedCatalogue(catalogue)));
    const original = new Map(entries(catalogue));

    it(`${locale}: every listed slot is unquoted and every property path is one {path}`, () => {
      const missed: string[] = [];
      for (const [key, template] of adjusted) {
        const group = key.slice(0, key.lastIndexOf('.'));
        const slots = SELF_QUOTED_SLOTS[key] ?? SELF_QUOTED_SLOTS[`${group}.*`] ?? [];
        for (const slot of slots) {
          if (!original.get(key)!.includes(`{${slot}}`)) continue;
          // The original must quote it the way the adjustment strips, and the copy must not.
          if (!original.get(key)!.includes(`"{${slot}}"`) || template.includes(`"{${slot}}"`)) missed.push(`${key} {${slot}}`);
        }
        if (PATH_GROUPS.includes(group) && original.get(key)!.includes('{pset}.{property}') && !template.includes('{path}')) {
          missed.push(`${key} {path}`);
        }
      }
      expect(missed).toEqual([]);
    });

    it(`${locale}: the exported catalogue is not modified`, () => {
      expect(entries(catalogue).some(([, t]) => t.includes('{path}'))).toBe(false);
      expect(original.get('requirements.attribute.mustExist')).toContain('"{name}"');
    });
  }
});
