/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Plain-language rendering of a facet in its section and optionality, for
 * Studio cards, diffs and agent summaries ("Doors must have FireRating in
 * Pset_DoorCommon").
 *
 * A thin adapter over `@ifc-lite/ids`' translation service, which owns
 * the locale catalogues and the constraint wording, so Studio and the
 * validation report never describe the same facet differently. A
 * dedicated per facet × section × cardinality renderer (with `it`) is
 * being added to `@ifc-lite/ids` in parallel; when it lands this function
 * delegates to it and keeps its signature.
 */

import { createTranslationService, type IDSFacet, type RequirementOptionality, type SupportedLocale, type TranslationService } from '@ifc-lite/ids';
import type { Section } from '../document/types.js';

const SERVICES = new Map<SupportedLocale, TranslationService>();

function service(locale: SupportedLocale): TranslationService {
  let s = SERVICES.get(locale);
  if (!s) {
    s = createTranslationService(locale);
    SERVICES.set(locale, s);
  }
  return s;
}

/**
 * Describe `facet` as it reads in `section`. `optionality` applies to
 * requirements only (applicability facets select, they do not require).
 */
export function describeFacet(
  facet: IDSFacet,
  section: Section,
  optionality: RequirementOptionality = 'required',
  locale: SupportedLocale = 'en',
): string {
  const s = service(locale);
  if (section === 'applicability') return s.describeFacet(facet, 'applicability');
  const required = s.describeRequirement({ id: '', facet, optionality: 'required' });
  if (optionality === 'required') return required;
  const text = s.describeRequirement({ id: '', facet, optionality });
  if (text !== required) return text;
  // The service only rewrites sentences that start with "Must …"; for the
  // others, state the optionality explicitly instead of returning a
  // sentence that reads as required. Prohibited facets are phrased as the
  // condition that must not hold.
  const label = s.getOptionalityText(optionality);
  return optionality === 'prohibited' ? `${label}: ${s.describeFacet(facet, 'applicability')}` : `${label}: ${required}`;
}
