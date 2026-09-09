/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression coverage for bringing IFC2X3 into codegen (#4202).
 *
 * `schemas/IFC2X3_TC1.exp` (the official buildingSMART express longform
 * distribution) is the first schema in this repo sourced with CRLF line
 * endings — `schemas/IFC4_ADD2_TC1.exp` and `schemas/IFC4X3.exp` are both
 * LF-only. Before normalizing it to LF on commit, generating from the raw
 * CRLF file produced a `schema-registry.ts` that failed to compile: the
 * `TYPE X = SELECT\r\n\t(A\r\n\t,B)` multi-line select-type text collapses
 * `\n` to a space (`typescript-generator.ts`'s existing escaping) but left
 * the `\r` characters in place, which `tsc` treats as an unterminated
 * string-literal line break. `IFC2X3_TC1.exp` has 12 `SET/LIST … OF UNIQUE`
 * occurrences (the syntax #4212 is filed against) — one more than either
 * existing schema — so this also re-asserts the existing UNIQUE-stripping
 * fix holds for a third schema rather than silently regressing when new
 * input reaches it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseExpressSchema } from '../src/express-parser.js';
import { generateTypeScript } from '../src/typescript-generator.js';

const SCHEMA_PATH = join(process.cwd(), 'schemas', 'IFC2X3_TC1.exp');

describe('IFC2X3_TC1.exp', () => {
  it('is committed with LF line endings, like the other two schemas', () => {
    const raw = readFileSync(SCHEMA_PATH, 'latin1');
    expect(raw).not.toContain('\r');
  });

  it('parses to a substantial, non-empty schema', () => {
    const schema = parseExpressSchema(readFileSync(SCHEMA_PATH, 'utf-8'));
    expect(schema.name).toBe('IFC2X3');
    // Fewer than IFC4 (776) — IFC2X3 predates materials/georeferencing/
    // infrastructure — but "substantial", not "the generator silently
    // produced nothing".
    expect(schema.entities.length).toBeGreaterThan(600);
    expect(schema.types.length).toBeGreaterThan(200);
    expect(schema.enums.length).toBeGreaterThan(100);
    expect(schema.selects.length).toBeGreaterThan(30);
  });

  it('generates entities.ts and schema-registry.ts with zero UNIQUE leaks', () => {
    const schema = parseExpressSchema(readFileSync(SCHEMA_PATH, 'utf-8'));
    const code = generateTypeScript(schema);

    expect(code.entities).not.toContain('UNIQUE');
    expect(code.schemaRegistry).not.toContain('UNIQUE');
  });

  it('generates a schema-registry.ts with no raw CR characters', () => {
    const schema = parseExpressSchema(readFileSync(SCHEMA_PATH, 'utf-8'));
    const code = generateTypeScript(schema);

    // A raw \r surviving into a single-quoted TS string literal breaks the
    // literal for tsc — see module doc. Guards the LF-normalization on
    // commit AND the escaping in typescript-generator.ts symmetrically:
    // either one alone is enough to keep this green.
    expect(code.schemaRegistry).not.toContain('\r');
  });
});
