/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure decision logic for the bSDD card's inline value controls (issue #1107,
 * item 10). Kept out of BsddCard.tsx so it can be unit-tested without pulling
 * the component's React / Radix / store dependency graph.
 */

import { type PropertyValue, PropertyValueType } from '@ifc-lite/data';
import type { BsddClassProperty } from '@/services/bsdd';

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

/** Default value used when a bSDD property is added without an inline choice. */
export function defaultValue(bsddType: string | null): PropertyValue {
  // Boolean gets a concrete default (false) so the value is valid the moment
  // it's added and the inline Switch has a state to toggle. Everything else
  // starts empty for manual entry.
  if (toPropertyValueType(bsddType) === PropertyValueType.Boolean) return false;
  return '';
}

/** Which inline value control (if any) a bSDD property offers before "Add". */
export function inlineControlKind(prop: BsddClassProperty): 'boolean' | 'enum' | null {
  if (toPropertyValueType(prop.dataType) === PropertyValueType.Boolean) return 'boolean';
  if (prop.allowedValues && prop.allowedValues.length > 0) return 'enum';
  return null;
}
