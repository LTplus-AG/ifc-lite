/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The property facet's `dataType` gate, shared by `checkPropertyFacet` and
 * its diagnostics-free twin `propertyFacetPasses` so that the two cannot
 * drift (#5224: they used to carry the same skip-on-absence condition).
 *
 * A property whose dataType is not known FAILS a dataType-constrained facet.
 * If the type cannot be established, the requirement cannot be asserted as
 * met. The one exemption is explicit: an `IfcPropertyTableValue` carries
 * `dataTypeMixed`, because its columns differ in type by design. It defers
 * to the value match against its candidates, as upstream ifctester does.
 */

import type { IDSConstraint, PropertySetInfo } from '../types.js';
import type { FacetCheckResult } from './index.js';
import { matchConstraint, formatConstraint, type MatchOptions } from '../constraints/index.js';

/** IFC data type names (IFCLABEL, IFCREAL, etc.) are case-insensitive */
const DATATYPE_OPTS: MatchOptions = { caseInsensitive: true };

type Prop = PropertySetInfo['properties'][number];

/** Whether `prop` satisfies the facet's `dataType` constraint. */
export function dataTypePasses(expected: IDSConstraint, prop: Prop): boolean {
  if (prop.dataTypeMixed) return true;
  return !!prop.dataType && matchConstraint(expected, prop.dataType, DATATYPE_OPTS);
}

/** The failure `checkSingleProperty` reports when {@link dataTypePasses} is
 *  false: MISMATCH when the type is known, UNKNOWN when it is not. */
export function dataTypeFailure(expected: IDSConstraint, psetName: string, prop: Prop): FacetCheckResult {
  const field = `${psetName}.${prop.name}`;
  const expectedText = formatConstraint(expected);
  if (!prop.dataType) {
    return {
      passed: false,
      actualValue: `${field} (dataType unknown)`,
      expectedValue: `dataType ${expectedText}`,
      failure: { type: 'PROPERTY_DATATYPE_UNKNOWN', field, expected: expectedText },
    };
  }
  return {
    passed: false,
    actualValue: `${field} (${prop.dataType})`,
    expectedValue: `dataType ${expectedText}`,
    failure: { type: 'PROPERTY_DATATYPE_MISMATCH', field, actual: prop.dataType, expected: expectedText },
  };
}
