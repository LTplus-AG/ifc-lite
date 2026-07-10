/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the CRC32 type-ID generator (packages/codegen/src/crc32.ts).
 *
 * This hash is a compatibility contract: it must match the pre-computed
 * IDs baked into the generated schema (packages/parser/src/generated/type-ids.ts)
 * and the web-ifc algorithm it mirrors. We pin known values from that
 * generated file (single source of truth for the codegen CLI's output)
 * rather than duplicating web-ifc's table here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { crc32, generateTypeIds, findCollisions } from '../src/crc32.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Parse the real, generated TYPE_IDS map (name -> pre-computed CRC32) out of
 * packages/parser/src/generated/type-ids.ts. This is the actual output the
 * codegen CLI produces and that @ifc-lite/parser ships at runtime, so it's
 * the real entity set / real known-value fixture for this contract.
 */
function loadGeneratedTypeIds(): Map<string, number> {
  const generatedPath = path.resolve(
    __dirname,
    '../../parser/src/generated/type-ids.ts',
  );
  const source = readFileSync(generatedPath, 'utf-8');
  const match = source.match(/export const TYPE_IDS = \{([\s\S]*?)\} as const;/);
  if (!match) {
    throw new Error('Could not locate TYPE_IDS block in generated type-ids.ts');
  }
  const body = match[1];
  const entryRegex = /(\w+):\s*(\d+),/g;
  const ids = new Map<string, number>();
  let entry: RegExpExecArray | null;
  while ((entry = entryRegex.exec(body)) !== null) {
    ids.set(entry[1], Number(entry[2]));
  }
  return ids;
}

describe('crc32', () => {
  it('matches the pre-computed IfcWall hash from generated/type-ids.ts', () => {
    // packages/parser/src/generated/type-ids.ts: IfcWall: 2391406946
    expect(crc32('IfcWall')).toBe(2391406946);
  });

  it('uppercases the input before hashing (case-insensitive contract)', () => {
    const upper = crc32('IFCWALL');
    const mixed = crc32('IfcWall');
    const lower = crc32('ifcwall');
    expect(mixed).toBe(upper);
    expect(mixed).toBe(lower);
    // Sanity: this is not the tautological "same string" case — the three
    // literal inputs are genuinely different strings.
    expect('IFCWALL').not.toBe('IfcWall');
    expect('ifcwall').not.toBe('IfcWall');
  });

  it('produces a 32-bit unsigned value in range', () => {
    const hash = crc32('IfcWall');
    expect(Number.isInteger(hash)).toBe(true);
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });

  it('produces different hashes for different names (not degenerate)', () => {
    expect(crc32('IfcWall')).not.toBe(crc32('IfcWindow'));
    expect(crc32('IfcWall')).not.toBe(crc32('IfcDoor'));
  });
});

describe('generateTypeIds', () => {
  it('matches every pre-computed ID in the real generated IFC4 schema output', () => {
    const generated = loadGeneratedTypeIds();
    expect(generated.size).toBeGreaterThan(500); // sanity: real, full IFC4 entity set

    const names = [...generated.keys()];
    const computed = generateTypeIds(names);

    for (const [name, expectedId] of generated) {
      expect(computed.get(name)).toBe(expectedId);
    }
  });
});

describe('findCollisions', () => {
  it('finds no collisions across the real, full IFC4 entity name set', () => {
    const generated = loadGeneratedTypeIds();
    const names = [...generated.keys()];

    const collisions = findCollisions(names);

    expect(collisions.size).toBe(0);
  });

  it('detects a deliberately-colliding pair (case-insensitive duplicate)', () => {
    // crc32() upcases its input, so a name differing only by case collides
    // with itself under this scheme -- this is exactly what findCollisions
    // must catch.
    const names = ['IfcWall', 'IFCWALL', 'IfcWindow'];

    const collisions = findCollisions(names);

    expect(collisions.size).toBe(1);
    const [[hash, colliding]] = [...collisions.entries()];
    expect(hash).toBe(crc32('IfcWall'));
    expect(colliding.sort()).toEqual(['IFCWALL', 'IfcWall'].sort());
  });
});
