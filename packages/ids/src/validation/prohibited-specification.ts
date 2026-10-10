/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A prohibited specification (`<applicability maxOccurs="0">`) says the
 * elements it applies to must not exist, so under IDS 1.0 every applicable
 * element is itself a violation (#7403). The specification already fails at
 * set level through cardinality; this module gives each applicable element
 * the per-element check that carries that verdict, so `entityResults`, the
 * pass/fail counts and the status agree, and per-element consumers (result
 * tables, BCF topics and comments) have a reason to show.
 *
 * The check is the specification's first applicability facet evaluated as a
 * `prohibited` requirement. An applicable element satisfies that facet by
 * definition, so the existing prohibited-requirement path in
 * `checkRequirement` fails it and words the failure with the
 * `failures.prohibited` message. A specification with no applicability
 * facets gets no synthetic check; the validator still fails its elements
 * through `maxOccurs === 0` directly.
 */

import type { IDSRequirement, IDSSpecification } from '../types.js';

/** Requirement id of the synthetic prohibition check; distinct from the parser's `req-N`. */
const PROHIBITED_APPLICABILITY_REQUIREMENT_ID = 'applicability-prohibited';

/**
 * The requirements to evaluate per applicable element of `spec`, read from the
 * spec as it is NOW. Deliberately uncached: callers (the viewer's IDS editor)
 * mutate specifications in place between runs, so a cache keyed by the spec
 * object would replay a stale check list. The validator calls this once per
 * specification per run and reuses the result for every element, which keeps
 * the synthetic requirement's identity stable for its description cache.
 */
export function requirementsToCheck(spec: IDSSpecification): readonly IDSRequirement[] {
  const facet = spec.applicability.facets[0];
  if (spec.maxOccurs !== 0 || !facet) return spec.requirements;
  return [
    ...spec.requirements,
    { id: PROHIBITED_APPLICABILITY_REQUIREMENT_ID, facet, optionality: 'prohibited' },
  ];
}
