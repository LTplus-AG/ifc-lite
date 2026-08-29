/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cell-to-value parsing for the CSV connector, split out so `csv-connector.ts`
 * stays within its module-size budget.
 */

import { PropertyValueType } from '@ifc-lite/data';
import type { PropertyValue } from './types.js';

/**
 * Returned for a Real/Integer cell that is not a number at all ("N/A", "TBD").
 * `parseFloat`/`parseInt` yield `NaN` for these and `NaN || 0` is `0`, which
 * writes a fabricated zero no consumer can tell from an imported one. Callers
 * must check for this sentinel and skip the cell instead.
 */
export const PARSE_INVALID = Symbol('csv-parse-invalid');

/** Parse a CSV cell to `type`, or {@link PARSE_INVALID} if it cannot be. */
export function parseValue(
  value: string,
  type: PropertyValueType
): PropertyValue | typeof PARSE_INVALID {
  switch (type) {
    case PropertyValueType.Real: {
      const parsed = parseFloat(value);
      return Number.isNaN(parsed) ? PARSE_INVALID : parsed;
    }

    case PropertyValueType.Integer: {
      const parsed = parseInt(value, 10);
      return Number.isNaN(parsed) ? PARSE_INVALID : parsed;
    }

    case PropertyValueType.Boolean:
    case PropertyValueType.Logical: {
      const lower = value.toLowerCase();
      return lower === 'true' || lower === 'yes' || lower === '1';
    }

    case PropertyValueType.List:
      try {
        return JSON.parse(value);
      } catch {
        // Legitimately silent: two accepted CSV encodings for a list value,
        // JSON first then semicolon-separated. A non-JSON cell is the normal
        // second form, not a failure.
        return value.split(';').map((s) => s.trim());
      }

    default:
      return value;
  }
}
