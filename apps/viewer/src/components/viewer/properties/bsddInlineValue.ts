/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure decision logic for the bSDD card's inline value controls (issue #1107,
 * item 10). Kept out of BsddCard.tsx so it can be unit-tested without pulling
 * the component's React / Radix / store dependency graph.
 */

import { type PropertyValue, PropertyValueType } from '@ifc-lite/data';

/** Map a bSDD dataType string to the viewer's PropertyValueType. */
export function toPropertyValueType(bsddType: string | null): PropertyValueType {
  if (!bsddType) return PropertyValueType.String;
  const lower = bsddType.toLowerCase();
  if (lower === 'boolean') return PropertyValueType.Boolean;
  if (lower === 'real' || lower === 'number') return PropertyValueType.Real;
  if (lower === 'integer') return PropertyValueType.Integer;
  if (lower === 'character' || lower === 'string') return PropertyValueType.String;
  return PropertyValueType.Label;
}

/**
 * Default value used when a bSDD property is added. The property is created
 * with its correct {@link toPropertyValueType} type but NO value — we never
 * decide a value on the user's behalf (issue #1107). An IFC property value is
 * legitimately optional, so a fresh Boolean is `null` (unset / `$`), not a
 * concrete `false`; everything else starts as an empty string. The user sets
 * the value (or leaves it empty) in the Properties tab.
 */
export function defaultValue(bsddType: string | null): PropertyValue {
  if (toPropertyValueType(bsddType) === PropertyValueType.Boolean) return null;
  return '';
}
