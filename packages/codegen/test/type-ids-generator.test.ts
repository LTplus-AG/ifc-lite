/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the type-ids generator (packages/codegen/src/type-ids-generator.ts).
 *
 * This module emits `type-ids.ts` — the `TYPE_IDS` (name -> CRC32) and
 * `TYPE_NAMES` (CRC32 -> name) maps every consumer of a generated schema
 * bundle uses for O(1) type lookup. The whole module had no test: inverting
 * the reverse map (`  IfcWall: 2391406946,` instead of `  2391406946:
 * 'IfcWall',`) still produced syntactically valid TypeScript and a green
 * suite, while `getTypeName(id)` would return `undefined` for every id at
 * runtime.
 *
 * The emitted file also ships executable helpers (`getTypeId`, `getTypeName`,
 * `isValidTypeId`, `normalizeTypeName`, `crc32Hash`). Because they are emitted
 * as TEXT, nothing in this package ever ran them. Here we transpile the
 * emitted module and execute it, so the helper semantics — not just their
 * presence as substrings — are pinned.
 */

import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { parseExpressSchema } from '../src/express-parser.js';
import { generateTypeIds } from '../src/type-ids-generator.js';
import { crc32, buildCRC32Table } from '../src/crc32.js';

const schema = parseExpressSchema(`
  SCHEMA TEST_TYPE_IDS;

  ENTITY IfcWall;
    GlobalId : IfcGloballyUniqueId;
  END_ENTITY;

  ENTITY IfcWallStandardCase
    SUBTYPE OF (IfcWall);
  END_ENTITY;

  ENTITY IfcDoor;
    GlobalId : IfcGloballyUniqueId;
  END_ENTITY;

  END_SCHEMA;
`);

const source = generateTypeIds(schema);

/** The runtime surface the emitted `type-ids.ts` ships to consumers. */
interface EmittedTypeIds {
  TYPE_IDS: Record<string, number>;
  TYPE_NAMES: Record<number, string>;
  getTypeId(name: string): number | undefined;
  getTypeName(id: number): string | undefined;
  isValidTypeId(id: number): boolean;
  crc32Hash(str: string): number;
}

/**
 * Transpile the emitted `type-ids.ts` and evaluate it, returning its exports.
 * The emitted module is self-contained (no imports), so a plain transpile +
 * dynamic import of a data: URL is enough — and it is the only way to test the
 * runtime helpers the generator ships to consumers.
 */
async function loadEmittedModule(code: string): Promise<EmittedTypeIds> {
  const js = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

/**
 * Extract the 256 hex literals of the emitted `CRC32_TABLE` from the
 * generated source TEXT (not by executing it — `CRC32_TABLE` itself is not
 * exported, only `crc32Hash` is). This is what actually pins the literal
 * table cell-by-cell: two of its 256 cells (index 111 and 245) were
 * hand-typed wrong in the old template and no test noticed, because the
 * only fixture name ('IfcNotInThisSchema') never happened to touch either
 * cell. See the crc32-table-corruption fix.
 */
function extractEmittedCRC32Table(code: string): number[] {
  const match = code.match(/const CRC32_TABLE = new Uint32Array\(\[([\s\S]*?)\]\);/);
  if (!match) throw new Error('CRC32_TABLE literal not found in emitted source');
  const hex = match[1].match(/0x[0-9a-fA-F]{8}/g);
  if (!hex) throw new Error('no hex literals found in CRC32_TABLE body');
  return hex.map((h) => Number.parseInt(h, 16));
}

describe('generateTypeIds — emitted source shape', () => {
  it('emits the forward map as name -> id', () => {
    expect(source).toContain(`  IfcWall: ${crc32('IfcWall')},\n`);
  });

  it('emits the reverse map as id -> name, not a second forward map', () => {
    expect(source).toContain(`  ${crc32('IfcWall')}: 'IfcWall',\n`);
    // Both directions: TYPE_NAMES must not be a duplicate of TYPE_IDS.
    const reverseBlock = source.slice(source.indexOf('export const TYPE_NAMES'));
    expect(reverseBlock).not.toContain(`  IfcWall: ${crc32('IfcWall')},`);
  });

  it('stamps the schema name into the banner', () => {
    expect(source).toContain('Generated from EXPRESS schema: TEST_TYPE_IDS');
  });

  it('covers every entity in both maps exactly once', () => {
    for (const entity of schema.entities) {
      const id = crc32(entity.name);
      expect(source.split(`  ${entity.name}: ${id},\n`).length - 1, entity.name).toBe(1);
      expect(source.split(`  ${id}: '${entity.name}',\n`).length - 1, entity.name).toBe(1);
    }
  });

  it('emits a CRC32_TABLE literal that matches buildCRC32Table() in all 256 cells', () => {
    // Full round-trip, not a spot check: a single hand-typed literal table
    // (the old template) can drift from the canonical table in exactly the
    // cells no fixture name happens to touch. Comparing every cell is the
    // only way a single-cell drift can't slip through again.
    const emitted = extractEmittedCRC32Table(source);
    const canonical = Array.from(buildCRC32Table());
    expect(emitted).toHaveLength(256);
    for (let i = 0; i < 256; i++) {
      expect(emitted[i], `cell ${i}`).toBe(canonical[i]);
    }
  });
});

/**
 * Guards the checked-in generated artifacts under `generated/`, not just the
 * generator function. The generator itself can be fixed while a stale
 * checked-in file keeps shipping the old, corrupted literal — which is
 * exactly what happened: `generated/ifc4/type-ids.ts` was regenerated after
 * the two-cell CRC32_TABLE corruption was fixed in the generator, but the
 * sibling `generated/ifc4x3/type-ids.ts` was not re-run and kept shipping
 * cells 111 and 245 wrong. Re-running `generateTypeIds` in-memory (as the
 * describe block above does) cannot catch that class of bug, because it
 * never reads the file that actually ships. This reads the real files from
 * disk instead.
 */
describe('checked-in generated artifacts — CRC32_TABLE stays in sync with the source', () => {
  const canonical = Array.from(buildCRC32Table());

  const generatedFiles = [
    ['ifc4', new URL('../generated/ifc4/type-ids.ts', import.meta.url)],
    ['ifc4x3', new URL('../generated/ifc4x3/type-ids.ts', import.meta.url)],
  ] as const;

  for (const [schemaName, fileUrl] of generatedFiles) {
    it(`generated/${schemaName}/type-ids.ts's CRC32_TABLE matches buildCRC32Table() in all 256 cells`, () => {
      const code = readFileSync(fileUrl, 'utf8');
      const emitted = extractEmittedCRC32Table(code);
      expect(emitted, `${schemaName}: table length`).toHaveLength(256);
      for (let i = 0; i < 256; i++) {
        expect(emitted[i], `${schemaName}: cell ${i}`).toBe(canonical[i]);
      }
    });
  }
});

describe('generateTypeIds — emitted runtime helpers (executed)', () => {
  it('TYPE_IDS and TYPE_NAMES round-trip', async () => {
    const mod = await loadEmittedModule(source);
    expect(mod.TYPE_IDS.IfcWall).toBe(crc32('IfcWall'));
    expect(mod.TYPE_NAMES[crc32('IfcWall')]).toBe('IfcWall');
  });

  it('getTypeId resolves the PascalCase name', async () => {
    const mod = await loadEmittedModule(source);
    expect(mod.getTypeId('IfcWall')).toBe(crc32('IfcWall'));
  });

  it('getTypeId normalises the UPPERCASE STEP spelling', async () => {
    const mod = await loadEmittedModule(source);
    expect(mod.getTypeId('IFCWALL')).toBe(crc32('IfcWall'));
    expect(mod.getTypeId('IFCWALLSTANDARDCASE')).toBe(crc32('IfcWallStandardCase'));
  });

  it('getTypeId returns undefined for an unknown name (negative direction)', async () => {
    const mod = await loadEmittedModule(source);
    expect(mod.getTypeId('IFCNOTATHING')).toBeUndefined();
    expect(mod.getTypeId('CompletelyUnrelated')).toBeUndefined();
  });

  it('getTypeName and isValidTypeId agree, in both directions', async () => {
    const mod = await loadEmittedModule(source);
    const id = crc32('IfcDoor');
    expect(mod.getTypeName(id)).toBe('IfcDoor');
    expect(mod.isValidTypeId(id)).toBe(true);

    expect(mod.getTypeName(1)).toBeUndefined();
    expect(mod.isValidTypeId(1)).toBe(false);
  });

  it('the emitted crc32Hash matches the generator crc32 (case-insensitive)', async () => {
    const mod = await loadEmittedModule(source);
    expect(mod.crc32Hash('IfcWall')).toBe(crc32('IfcWall'));
    expect(mod.crc32Hash('IFCWALL')).toBe(crc32('IfcWall'));
    // Sanity: not degenerate.
    expect(mod.crc32Hash('IfcWall')).not.toBe(mod.crc32Hash('IfcDoor'));
    // And it agrees on a name that is NOT in the schema, which is the whole
    // point of shipping the hash function alongside the tables.
    expect(mod.crc32Hash('IfcNotInThisSchema')).toBe(crc32('IfcNotInThisSchema'));
  });

  it('hashes a vendor-extension-shaped name that actually routes through the previously-corrupted table cell', async () => {
    // 'IfcNotInThisSchema' (above) never touches CRC32_TABLE cell 111 or 245
    // — the two cells that were hand-typed wrong — which is exactly why the
    // corruption shipped undetected. 'IfcFooBarBaz' is a realistic
    // vendor-extension-style entity keyword (the actual call site,
    // IfcType::from_str's Unknown(crc32_hash(...)) fallback, is reached for
    // any unrecognized entity keyword) whose CRC32 computation indexes
    // table cell 111 partway through. Confirmed by tracing the algorithm.
    const mod = await loadEmittedModule(source);
    expect(mod.crc32Hash('IfcFooBarBaz')).toBe(crc32('IfcFooBarBaz'));
  });
});
