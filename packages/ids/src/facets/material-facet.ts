/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Material facet checker
 */

import type { IDSMaterialFacet, IFCDataAccessor } from '../types.js';
import type { FacetCheckResult } from './index.js';
import { matchConstraint, formatConstraint } from '../constraints/index.js';

/**
 * Check if an entity matches a material facet
 */
export function checkMaterialFacet(
  facet: IDSMaterialFacet,
  expressId: number,
  accessor: IFCDataAccessor
): FacetCheckResult {
  // Get materials for the entity
  const materials = accessor.getMaterials(expressId);

  // A `unresolved` entry (#5227) does NOT prove the entity has a readable
  // material — it only means an IfcRelAssociatesMaterial edge (or type-level
  // association) exists but this store has no source bytes to read the
  // material's name/category/etc. Only a "proven" entry (a real material, or
  // #5227's proven-but-unreadable `unresolved`) may be treated as evidence
  // of presence. Empty result genuinely means no material.
  const hasAnyMaterials = materials.length > 0;
  const hasProvenMaterials = materials.some((m) => !m.unresolved);

  // If no value constraint, just check if any material exists
  if (!facet.value) {
    if (!hasProvenMaterials) {
      if (hasAnyMaterials) {
        // Every entry is `unresolved` — cannot fabricate a pass.
        return unresolvedResult();
      }
      return {
        passed: false,
        actualValue: '(none)',
        expectedValue: 'any material',
        failure: {
          type: 'MATERIAL_MISSING',
          expected: 'any material',
        },
      };
    }

    return {
      passed: true,
      actualValue: materials.map((m) => m.name).join(', '),
      expectedValue: 'any material',
    };
  }

  // If entity has no materials at all, return MATERIAL_MISSING
  // (not VALUE_MISMATCH — that implies we found _some_ materials)
  if (!hasAnyMaterials) {
    return {
      passed: false,
      actualValue: '(none)',
      expectedValue: formatConstraint(facet.value),
      failure: {
        type: 'MATERIAL_MISSING',
        expected: formatConstraint(facet.value),
      },
    };
  }

  // Every entry is `unresolved` (#5227) — before treating this as "no
  // materials matched", note that we cannot even say the entity HAS a readable
  // material, let alone whether a resolved value would have matched. This
  // must be checked before the resolved/unresolved split below, or an
  // unresolved entry would fall through `hasUnresolved` and get the "confirmed
  // material exists" `unresolvedResult` wording, which asserts presence this
  // pathway never proved.
  if (!hasProvenMaterials) {
    return unresolvedResult();
  }

  // Only entries whose attributes were actually readable can be matched
  // against a value constraint. An `unresolved` entry (confirmed materially
  // associated, but this store has no source bytes to read name/category/etc
  // from — issue #5227) carries `name: undefined`/`category: undefined`,
  // which is NOT a genuine empty material: matching it would either silently
  // PASS a required facet that should have failed, or silently FAIL one that
  // would have matched had the data been readable. Match against the resolved
  // subset only, and report MATERIAL_UNRESOLVED — distinct from MISSING
  // (genuinely unmaterialed) and from a MISMATCH (we read a value and it
  // didn't match) — whenever an unresolved entry could have been the reason
  // no resolved entry matched.
  const resolvedMaterials = materials.filter((m) => !m.unresolved);
  const hasUnresolved = resolvedMaterials.length < materials.length;

  // Check if any material matches the value constraint
  const matchingMaterials = resolvedMaterials.filter(
    (m) =>
      matchConstraint(facet.value!, m.name) ||
      (m.category && matchConstraint(facet.value!, m.category))
  );

  if (matchingMaterials.length === 0) {
    if (hasUnresolved) {
      return unresolvedResult();
    }

    const availableMaterials = resolvedMaterials.map((m) => m.name).join(', ');

    return {
      passed: false,
      actualValue: availableMaterials || '(none)',
      expectedValue: formatConstraint(facet.value),
      failure: {
        type: 'MATERIAL_VALUE_MISMATCH',
        field: 'material',
        actual: availableMaterials,
        expected: formatConstraint(facet.value),
        context: {
          availableMaterials,
        },
      },
    };
  }

  return {
    passed: true,
    actualValue: matchingMaterials.map((m) => m.name).join(', '),
    expectedValue: formatConstraint(facet.value),
  };
}

/**
 * Result for a value-constrained facet when the entity is confirmed
 * materially associated but no *readable* material matched, and at least one
 * *unreadable* one exists that might have. `passed: false` is the closest
 * this engine's boolean result can get to "could not determine" — the
 * distinguishing signal is `failure.type` (`MATERIAL_UNRESOLVED`, never
 * `_MISSING`/`_MISMATCH`), so a report can tell "cannot verify" apart from
 * a genuine violation instead of treating both as the same failure.
 */
function unresolvedResult(): FacetCheckResult {
  return {
    passed: false,
    actualValue: '(unresolved)',
    expectedValue: 'resolvable material',
    failure: {
      type: 'MATERIAL_UNRESOLVED',
      expected: 'resolvable material',
      context: {
        reason:
          'Entity carries a material association reachable only via IfcRelAssociatesMaterial, but the material attributes are unavailable on this data source (server-parsed model without source bytes).',
      },
    },
  };
}
