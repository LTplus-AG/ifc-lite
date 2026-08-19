/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `resolveDuckDBStringLiteral` (duckdb-integration.ts) is the DuckDB-WASM
 * sibling of `getPropertyValue`'s String-branch NULL-sentinel guard in
 * `@ifc-lite/data`'s property-table.ts (and its cache-restored twin in
 * `@ifc-lite/cache`'s properties.ts): `valueString` is a Uint32Array, so the
 * -1 NULL sentinel written by `StringTable.intern(null)` wraps to
 * 4294967295. An `idx >= 0` check is always true for an unsigned array and
 * never catches it — only an in-range check (`idx < strings.count`) does.
 * Before this guard, a NULL string-typed property registered into the SQL
 * `properties` table as the literal `''`, indistinguishable from a real
 * empty-string property.
 */

import { describe, expect, it } from 'vitest';
import { StringTable } from '@ifc-lite/data';
import { resolveDuckDBStringLiteral } from './duckdb-integration.js';

const NULL_STRING_SENTINEL = 0xffffffff; // -1 written into a Uint32Array

describe('resolveDuckDBStringLiteral: String NULL sentinel', () => {
  it('emits SQL NULL for the wrapped sentinel index, not the empty-string literal', () => {
    const strings = StringTable.fromArray(['', 'Pset_Test', 'Name']);
    expect(resolveDuckDBStringLiteral(NULL_STRING_SENTINEL, strings)).toBe('NULL');
  });

  it('still emits a quoted literal for an in-range index, including the real empty string', () => {
    const strings = StringTable.fromArray(['', 'Wall-01']);
    expect(resolveDuckDBStringLiteral(1, strings)).toBe("'Wall-01'");
    expect(resolveDuckDBStringLiteral(0, strings)).toBe("''");
  });
});
