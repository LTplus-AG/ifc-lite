/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cell-to-value parsing for every table import path: `CsvConnector` and the
 * flow table nodes (`@ifc-lite/flow-nodes`' CSV/XLSX readers and
 * `model.applyTable`) all parse through this one function, so they agree on
 * what a cell means.
 */

import { PropertyValueType } from '@ifc-lite/data';
import type { PropertyValue } from './types.js';

/**
 * Returned for a cell that is not a complete value of its type: `"N/A"` in a
 * Real column, `"12,5"` (decimal comma), `"60abc"`, `"2.7"` in an Integer
 * column, `"ja"` in a Boolean one. Callers must check for this sentinel and
 * report and skip the cell, never write a substitute.
 */
export const PARSE_INVALID = Symbol('csv-parse-invalid');

/**
 * The WHOLE trimmed cell has to match; nothing is guessed. `parseFloat` reads
 * the longest numeric prefix, so the lenient parse this replaced wrote
 * `"12,5"` as 12 and `"60abc"` as 60, and every word but true/yes/1 became
 * `false` (#5427). A decimal comma is refused rather than converted: `1,250`
 * is a thousands separator in one locale and 1.25 in another. Exponent form
 * (`1.2E-05`) is accepted, because spreadsheets export small numbers that way
 * and it has one reading.
 */
const REAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const INTEGER = /^[+-]?\d+$/;
/**
 * IFC LOGICAL's UNKNOWN is deliberately absent: the property model carries a
 * boolean, and writing UNKNOWN as `false` would state a fact the sheet did not.
 */
const BOOLEAN = /^(true|false|yes|no|1|0)$/i;
const TRUE = /^(true|yes|1)$/i;

/**
 * Parse a cell to `type`, or {@link PARSE_INVALID} if the cell is not exactly
 * a value of that type. Surrounding whitespace is ignored for typed cells;
 * text types are returned as given.
 */
export function parseValue(
  value: string,
  type: PropertyValueType
): PropertyValue | typeof PARSE_INVALID {
  switch (type) {
    case PropertyValueType.Real: {
      // The syntax alone admits `1e309`, which is Infinity.
      const text = value.trim();
      const parsed = Number(text);
      return REAL.test(text) && Number.isFinite(parsed) ? parsed : PARSE_INVALID;
    }

    case PropertyValueType.Integer: {
      // Past 2^53 the number is silently rounded to a neighbour.
      const text = value.trim();
      const parsed = Number(text);
      return INTEGER.test(text) && Number.isSafeInteger(parsed) ? parsed : PARSE_INVALID;
    }

    case PropertyValueType.Boolean:
    case PropertyValueType.Logical: {
      const text = value.trim();
      return BOOLEAN.test(text) ? TRUE.test(text) : PARSE_INVALID;
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
