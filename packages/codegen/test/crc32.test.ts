/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the CRC32 type-ID generator (packages/codegen/src/crc32.ts).
 *
 * This hash is a compatibility contract: it must match the pre-computed
 * IDs baked into the generated schema (packages/parser/src/generated/type-ids.ts)
 * and the web-ifc algorithm it mirrors.
 *
 * Two layers of assertion, doing different jobs:
 *  - `crc32 specification vectors` pins crc32() to CRC-32/ISO-HDLC using
 *    values that come from outside this repository. Nothing else in this file
 *    can catch an algorithmic error, because everything else compares crc32()
 *    against output crc32() produced.
 *  - the remaining suites pin the *generator* to those hashes via the real
 *    generated file (packages/parser/src/generated/type-ids.ts), the single
 *    source of truth for the codegen CLI's output.
 */

import { describe, it, expect } from 'vitest';
import { crc32, generateTypeIds, findCollisions, formatCRC32TableLiteral } from '../src/crc32.js';
import { TYPE_IDS } from '../../parser/src/generated/type-ids.js';

/**
 * The real, generated TYPE_IDS map (name -> pre-computed CRC32) that
 * @ifc-lite/parser ships at runtime — the actual output of the codegen CLI, so
 * the real entity set / real known-value fixture for this contract.
 *
 * IMPORTED rather than regexed out of the file's text (#2434). The previous
 * form matched `export const TYPE_IDS = {…} as const;` and then `(\w+):\s*(\d+),`
 * per entry, which meant the fixture silently shrank whenever the emitted shape
 * shifted: drop the `as const`, wrap the object, or emit hex ids and the outer
 * regex stops matching (loud) — but a per-entry change quietly yields FEWER
 * pairs, and every "agrees across the full entity set" loop below then agrees
 * across a subset it never noticed it was handed. The import is the same data,
 * from the module system, and cannot half-parse.
 */
function loadGeneratedTypeIds(): Map<string, number> {
  return new Map(Object.entries(TYPE_IDS));
}

/**
 * Independent, bit-at-a-time reference implementation of CRC-32/ISO-HDLC,
 * written straight from the algorithm's parameters rather than from
 * src/crc32.ts:
 *
 *   width=32  poly=0x04C11DB7  init=0xFFFFFFFF
 *   refin=true  refout=true  xorout=0xFFFFFFFF  check=0xCBF43926
 *
 * This shares no code and no constants with the implementation under test:
 * src/crc32.ts is table-driven and uses the *reflected* polynomial
 * 0xEDB88320 with right shifts; this one is table-free and uses the
 * *unreflected* polynomial 0x04C11DB7 with left shifts, reflecting each
 * input byte on the way in and the register on the way out. Two independent
 * routes to the same specification, so agreement between them is evidence
 * about the specification and not a tautology.
 */
function reflect(value: number, width: number): number {
  let out = 0;
  for (let i = 0; i < width; i++) {
    if ((value >>> i) & 1) out |= 1 << (width - 1 - i);
  }
  return out >>> 0;
}

function crc32Reference(input: string): number {
  let reg = 0xffffffff;
  for (let i = 0; i < input.length; i++) {
    const byte = input.charCodeAt(i);
    if (byte > 0xff) {
      throw new Error(`crc32Reference: non-byte input at ${i}: ${byte}`);
    }
    reg = (reg ^ (reflect(byte, 8) << 24)) >>> 0;
    for (let bit = 0; bit < 8; bit++) {
      reg =
        (reg & 0x80000000) !== 0
          ? ((reg << 1) ^ 0x04c11db7) >>> 0
          : (reg << 1) >>> 0;
    }
  }
  return (reflect(reg, 32) ^ 0xffffffff) >>> 0;
}

describe('crc32 specification vectors', () => {
  // Without these, every other assertion in this file compares crc32() with
  // itself (directly, or via generated/type-ids.ts which crc32() produced).
  // A wrong-but-self-consistent hash would pass all of them. These are the
  // only assertions here whose expected values come from outside our code.
  //
  // These IDs cross a language boundary: rust/core/src/generated/schema.rs
  // hashes unknown type names with its own CRC32 and the TS table is shipped
  // by @ifc-lite/parser. Two internally coherent tables that disagree with
  // each other is exactly the failure a self-check cannot see, so the same
  // vectors are pinned on the Rust side in
  // rust/core/tests/crc32_spec_vectors.rs.

  it('matches the standard CRC-32/ISO-HDLC check value', () => {
    // "check" is defined by the algorithm's specification as the CRC of the
    // nine ASCII bytes "123456789". crc32() uppercases its input first, but
    // digits are unaffected by case, so the vector applies unchanged.
    expect(crc32('123456789')).toBe(0xcbf43926);
  });

  it('hashes the empty string to the specified xorout identity', () => {
    // With no input the register never leaves init=0xFFFFFFFF, so the result
    // is init ^ xorout = 0xFFFFFFFF ^ 0xFFFFFFFF = 0.
    expect(crc32('')).toBe(0x00000000);
  });

  it('agrees with an independent bit-at-a-time reference implementation', () => {
    // Anchor the reference itself to the published check value before
    // trusting it as an oracle.
    expect(crc32Reference('123456789')).toBe(0xcbf43926);
    expect(crc32Reference('')).toBe(0x00000000);

    // crc32() uppercases; feed the reference the already-uppercased form so
    // the comparison is about the hash, not about the case folding (which
    // has its own test below).
    const names = [
      'IFCWALL',
      'IFCWINDOW',
      'IFCDOOR',
      'IFCPROJECT',
      'IFCBUILDINGSTOREY',
      'IFCEXTRUDEDAREASOLID',
      'IFCTRIANGULATEDFACESET',
      'IFCNOTATYPE',
      'A',
      'AB',
      'ABC',
    ];
    for (const name of names) {
      expect(crc32(name)).toBe(crc32Reference(name));
    }
  });

  it('agrees with the reference across the full generated IFC entity set', () => {
    const generated = loadGeneratedTypeIds();
    expect(generated.size).toBeGreaterThan(500);
    for (const name of generated.keys()) {
      expect(crc32(name)).toBe(crc32Reference(name.toUpperCase()));
    }
  });
});

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

describe('formatCRC32TableLiteral perLine validation', () => {
  // Review finding on PR #2359: perLine <= 0 makes the `i += perLine` loop
  // non-terminating, and a non-integer perLine is a silent formatting
  // footgun. The exported helper should reject these rather than hang or
  // emit something no caller asked for.
  it('rejects perLine = 0 instead of looping forever', () => {
    expect(() => formatCRC32TableLiteral('  ', 0)).toThrow(/perLine/);
  }, 10_000);

  it('rejects a negative perLine instead of looping forever', () => {
    expect(() => formatCRC32TableLiteral('  ', -1)).toThrow(/perLine/);
  }, 10_000);

  it('rejects a fractional perLine', () => {
    expect(() => formatCRC32TableLiteral('  ', 2.5)).toThrow(/perLine/);
  });

  it('still accepts the default perLine (6) and produces the historical layout', () => {
    const literal = formatCRC32TableLiteral('  ');
    const lines = literal.split('\n');
    expect(lines).toHaveLength(Math.ceil(256 / 6));
    expect(lines[0]).toBe(
      '  0x00000000, 0x77073096, 0xee0e612c, 0x990951ba, 0x076dc419, 0x706af48f,'
    );
    // Last line has the 256 % 6 = 4 remaining entries.
    expect(lines[lines.length - 1].match(/0x[0-9a-f]{8}/g)).toHaveLength(4);
  });
});
