/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IDSSpecification } from '@ifc-lite/ids';
import type { SpecCardinality } from '@ifc-lite/ids-authoring';

/**
 * The cardinality a specification's applicability occurs bounds express
 * (IDS 1.0): `maxOccurs="0"` is prohibited, `minOccurs` ≥ 1 is required,
 * anything else optional (an absent `minOccurs` defaults to 0).
 */
export function specCardinality(spec: IDSSpecification): SpecCardinality {
  if (spec.maxOccurs === 0) return 'prohibited';
  return (spec.minOccurs ?? 0) >= 1 ? 'required' : 'optional';
}
