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

    case PropertyValueType.List: {
      // Two accepted CSV encodings, resolved in three steps: a valid JSON
      // ARRAY wins, a semicolon is the unambiguous marker of the other
      // form, and only a cell that looks like JSON, carries no semicolon,
      // and still will not parse is refused. Valid JSON that is not an
      // array (`5`, `{"a":1}`) is not a list either, so it falls to the
      // semicolon path and becomes a one-element list, as before.
      //
      // Both simpler rules are wrong in opposite directions. Deciding on the
      // thrown exception sent malformed JSON down the semicolon path, so
      // `[1,2` parsed to `['[1,2']` -- a fabricated value of exactly the kind
      // PARSE_INVALID exists to keep out. Deciding on a leading `[` alone
      // refused `[EXT];[LOAD]`, a legitimate semicolon list whose first entry
      // starts with `[`, dropping cells that imported correctly before.
      const trimmed = value.trim();
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed as PropertyValue;
      } catch {
        // Not JSON. Fall through to the shape checks below.
      }
      if (trimmed.includes(';')) return trimmed.split(';').map((s) => s.trim());
      if (trimmed.startsWith('[')) return PARSE_INVALID;
      return trimmed.split(';').map((s) => s.trim());
    }

    default:
      return value;
  }
}
