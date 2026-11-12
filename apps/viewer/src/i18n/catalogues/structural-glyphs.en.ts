/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tooltips of the structural support and load glyphs (#9668). A lazy
 * catalogue: it loads with the glyph overlay and registers itself
 * (`lazy-catalogues.ts`), so it adds nothing to the page's first load.
 */
import type { TranslationValue } from '../types';

export const structuralGlyphsEn = {
  'structuralGlyphs.support.fixed': 'Fixed support',
  'structuralGlyphs.support.pinned': 'Pinned support',
  'structuralGlyphs.support.roller': 'Roller support',
  'structuralGlyphs.support.spring': 'Spring support',
  'structuralGlyphs.load.force': 'Force',
  'structuralGlyphs.load.moment': 'Moment',
  'structuralGlyphs.load.temperature': 'Temperature load',
  'structuralGlyphs.load.displacement': 'Imposed displacement',
  'structuralGlyphs.tooltip': '{kind} · {entity}',
} as const satisfies Record<string, TranslationValue>;
