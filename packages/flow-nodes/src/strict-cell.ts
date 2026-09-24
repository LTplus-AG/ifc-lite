/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Is a spreadsheet cell's text a COMPLETE value of its column's type?
 *
 * `@ifc-lite/mutations`' `parseValue` is lenient by construction: `parseFloat`
 * reads the longest numeric prefix, so `"12,5"` becomes 12 and `"60abc"`
 * becomes 60, and every string other than true/yes/1 becomes `false`. A
 * European CSV (`12,5` in a Real column) therefore wrote 12 into the model
 * with nothing reported. This check runs first at every table→value boundary
 * (the CSV and XLSX readers, and `model.applyTable`), so a value is either
 * exactly what the cell says or reported and left unwritten (#5377 review).
 */

import type { ColumnType } from '@ifc-lite/flow';
import { PARSE_INVALID, parseValue, type PropertyValue } from '@ifc-lite/mutations';
import { VALUE_TYPE_BY_COLUMN_TYPE } from './table-nodes.js';

const REAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const INTEGER = /^[+-]?\d+$/;
/**
 * IFC LOGICAL's UNKNOWN is deliberately absent: the property model carries a
 * boolean, and writing UNKNOWN as `false` would state a fact the sheet did not.
 */
const BOOLEAN = /^(true|false|yes|no|1|0)$/i;

function isStrictlyTyped(text: string, type: ColumnType): boolean {
  switch (type) {
    // The syntax alone admits `1e309` (Infinity) and integers past 2^53
    // (silently rounded), so the value itself is checked too.
    case 'real': return REAL.test(text) && Number.isFinite(Number(text));
    case 'integer': return INTEGER.test(text) && Number.isSafeInteger(Number(text));
    case 'boolean':
    case 'logical': return BOOLEAN.test(text);
    default: return true;
  }
}

/**
 * Parse a cell as its column's type, or {@link PARSE_INVALID}. The text is
 * trimmed ONCE and the same text is both checked and parsed: checking the
 * trimmed text but parsing the raw one accepted `" true "` and wrote `false`.
 */
export function parseStrictCell(raw: string, type: ColumnType): PropertyValue | typeof PARSE_INVALID {
  const text = raw.trim();
  return isStrictlyTyped(text, type) ? parseValue(text, VALUE_TYPE_BY_COLUMN_TYPE[type]) : PARSE_INVALID;
}
