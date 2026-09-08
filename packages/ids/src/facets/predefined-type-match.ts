/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The single implementation of IDS `<predefinedType>` matching.
 *
 * The IDS XSD gives the entity facet and the `partOf` facet's nested
 * `<entity>` element the SAME complex type, so both must resolve a
 * `<predefinedType>` literal against the same two-branch rule. That rule
 * used to be written out three times — twice in `entity-facet.ts`
 * (`checkEntityFacet` and its diagnostics-free twin `entityFacetPasses`)
 * and once in `partof-facet.ts` — and the copies drifted: the partOf one
 * compared case-INSENSITIVELY where the entity ones compared
 * case-sensitively, so one and the same (raw enum, user-defined name,
 * literal) triple got opposite verdicts depending on which facet asked.
 *
 * The rule, per IDS spec and the buildingSMART test corpus:
 *
 *  1. Compare against the raw IFC `PredefinedType` enum token (`BEAM`,
 *     `USERDEFINED`, `NOTDEFINED`, …).
 *  2. Only when that raw token is `USERDEFINED`, fall back to the
 *     user-defined name (`ObjectType`/`ElementType`/`ProcessType`).
 *  3. When no raw token is reported at all (legacy accessors that do not
 *     implement `getPredefinedTypeRaw`), compare against the
 *     user-defined name directly.
 *
 * Both comparisons are CASE-SENSITIVE: enum tokens are uppercase by the
 * IFC schema and the IDS literal must match them exactly, and the corpus
 * pins the user-defined name the same way — `entity/`
 * `fail-user_defined_types_are_checked_case_sensitively.ids` requires an
 * `IfcWall` carrying `ObjectType = 'waldo'` to FAIL a facet asking for
 * `WALDO`.
 *
 * Branch order matters: a facet asking for the literal `USERDEFINED`
 * must match an entity whose enum IS `USERDEFINED`, whatever custom name
 * accompanies it.
 *
 * Callers get a verdict, never the intermediate booleans — the failure
 * wording (`PREDEFINED_TYPE_MISMATCH` vs `PARTOF_PREDEFINED_TYPE_MISMATCH`,
 * and the surrounding `actualValue` phrasing) is the only part that
 * legitimately differs between the two facets, so that is all each caller
 * still owns.
 */

import type { IDSConstraint } from '../types.js';
import { matchConstraint } from '../constraints/index.js';

export type PredefinedTypeMatch =
  /** The constraint is satisfied. */
  | { readonly kind: 'match' }
  /** Neither a raw enum token nor a user-defined name is available. */
  | { readonly kind: 'absent' }
  /**
   * Something was available and it did not satisfy the constraint.
   * `actual` is the display form both facets report — the user-defined
   * name when there is one, else the raw token.
   */
  | { readonly kind: 'mismatch'; readonly actual: string };

/**
 * Resolve an IDS `<predefinedType>` constraint against an entity's raw
 * `PredefinedType` enum token and its user-defined name.
 */
export function matchPredefinedType(
  constraint: IDSConstraint,
  rawType: string | undefined,
  userDefinedType: string | undefined
): PredefinedTypeMatch {
  if (!rawType && !userDefinedType) return { kind: 'absent' };

  if (rawType && matchConstraint(constraint, rawType)) {
    return { kind: 'match' };
  }
  if (
    rawType === 'USERDEFINED' &&
    userDefinedType &&
    userDefinedType !== rawType &&
    matchConstraint(constraint, userDefinedType)
  ) {
    return { kind: 'match' };
  }
  if (!rawType && userDefinedType && matchConstraint(constraint, userDefinedType)) {
    return { kind: 'match' };
  }

  return { kind: 'mismatch', actual: userDefinedType || rawType || '(none)' };
}
