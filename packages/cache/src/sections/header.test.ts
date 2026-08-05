/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * header.ts had no dedicated unit test: it was only exercised indirectly
 * through BinaryCacheWriter/Reader in cache.test.ts, whose assertions on the
 * header (`header.version`, `header.entityCount`, `header.schema`,
 * `header.sections.length`) never pin MAGIC or FORMAT_VERSION to a literal
 * byte sequence, and never inspect an individual section-table entry's
 * `flags` / `compressedSize` fields. Mutation testing (audit round 11)
 * confirmed both are real coverage gaps:
 *  - bumping FORMAT_VERSION (types.ts) from 13 to 14 left the full cache
 *    test suite green, because every existing check compares
 *    `header.version` against the *imported* FORMAT_VERSION constant, which
 *    moves in lockstep with the bug.
 *  - corrupting a section entry's `flags` or `compressedSize` field (writing
 *    a constant instead of the real value) also left the suite green — no
 *    test reads those fields back. They are currently always
 *    `SectionFlags.None` / `0` in production (no writer sets them to
 *    anything else yet), so this is a latent gap, not a live defect.
 */

import { describe, it, expect } from 'vitest';
import { writeHeader, readHeader } from './header.js';
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';
import {
  MAGIC,
  FORMAT_VERSION,
  HeaderFlags,
  SectionFlags,
  SectionType,
  SchemaVersion,
  type CacheHeader,
  type SectionEntry,
} from '../types.js';

const header: CacheHeader = {
  magic: MAGIC,
  version: FORMAT_VERSION,
  flags: HeaderFlags.HasGeometry,
  sourceHash: 0x0123456789abcdefn,
  schema: SchemaVersion.IFC4,
  entityCount: 7,
  totalVertices: 11,
  totalTriangles: 13,
  sectionCount: 2,
};

// Two section entries with all-distinct field values (including flags and
// compressedSize, which existing round-trip tests never check) so a swapped
// or dropped field cannot hide behind a repeated value.
const sections: SectionEntry[] = [
  { type: SectionType.Strings, flags: SectionFlags.Compressed, offset: 1000, size: 2000, compressedSize: 500 },
  { type: SectionType.Entities, flags: SectionFlags.None, offset: 3000, size: 4000, compressedSize: 999 },
];

describe('writeHeader', () => {
  it('pins MAGIC and FORMAT_VERSION to their LITERAL on-disk bytes, not just the imported constants', () => {
    // Asserting against the imported constants (as cache.test.ts does) would
    // stay green even if FORMAT_VERSION or MAGIC silently changed value,
    // since the assertion moves with the bug. Pin the actual wire bytes.
    const writer = new BufferWriter();
    writeHeader(writer, header, sections);
    const buf = new Uint8Array(writer.build());
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    // magic: uint32 LE at byte 0 — "IFCL" read little-endian is 0x4C434649.
    expect(view.getUint32(0, true)).toBe(0x4c434649);
    expect(Array.from(buf.subarray(0, 4))).toEqual([0x49, 0x46, 0x43, 0x4c]);

    // version: uint16 LE at byte 4.
    expect(view.getUint16(4, true)).toBe(13);
  });

  it('writes each section-table entry field at its documented byte offset within the 16-byte entry', () => {
    const writer = new BufferWriter();
    writeHeader(writer, header, sections);
    const buf = new Uint8Array(writer.build());
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    // Section table starts right after the 64-byte header.
    const tableStart = 64;
    // Entry 0 (Strings): type(2) flags(2) offset(4) size(4) compressedSize(4).
    expect(view.getUint16(tableStart + 0, true)).toBe(SectionType.Strings);
    expect(view.getUint16(tableStart + 2, true)).toBe(SectionFlags.Compressed);
    expect(view.getUint32(tableStart + 4, true)).toBe(1000);
    expect(view.getUint32(tableStart + 8, true)).toBe(2000);
    expect(view.getUint32(tableStart + 12, true)).toBe(500);
  });
});

describe('writeHeader/readHeader round-trip', () => {
  it('round-trips every section-entry field, including flags and compressedSize (offset/size are already exercised functionally by cache.test.ts via section lookup; flags/compressedSize are not read by any other code path today)', () => {
    const writer = new BufferWriter();
    writeHeader(writer, header, sections);
    const reader = new BufferReader(writer.build());
    const info = readHeader(reader);

    expect(info.sections).toEqual(sections);
    expect(info.sections[0].flags).toBe(SectionFlags.Compressed);
    expect(info.sections[0].compressedSize).toBe(500);
    expect(info.sections[1].flags).toBe(SectionFlags.None);
    expect(info.sections[1].compressedSize).toBe(999);
  });

  it('rejects a cache written with a future format version', () => {
    const writer = new BufferWriter();
    writeHeader(writer, { ...header, version: FORMAT_VERSION + 1 }, sections);
    const reader = new BufferReader(writer.build());
    expect(() => readHeader(reader)).toThrow(/Unsupported format version/);
  });

  it('rejects a buffer with garbage magic bytes', () => {
    const writer = new BufferWriter();
    writeHeader(writer, header, sections);
    const buf = new Uint8Array(writer.build());
    buf[0] = 0xff; // corrupt the first magic byte
    const reader = new BufferReader(buf.buffer);
    expect(() => readHeader(reader)).toThrow(/Invalid magic bytes/);
  });
});
