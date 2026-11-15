/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Staleness guard for packages/cache/SPEC.md (#9584). The spec is the
 * compatibility contract a second writer is built against, so the values a
 * reader keys on must not drift from the code silently: the declared current
 * version and the bit/value tables for the enums written to disk.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FORMAT_VERSION, GeometryChunkFlags, HeaderFlags, SectionType } from './types.js';

const spec = readFileSync(new URL('../SPEC.md', import.meta.url), 'utf8');

/** Lines of the spec between `### <heading>` and the next heading. */
function block(heading: string): string[] {
  const lines = spec.split('\n');
  const start = lines.findIndex((line) => line.trim() === `### ${heading}`);
  if (start < 0) throw new Error(`SPEC.md has no "### ${heading}" heading`);
  const end = lines.findIndex((line, i) => i > start && /^#{1,3} /.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/** Numeric members of a TS enum, without its reverse mapping or `None`. */
function members(e: Record<string, string | number>): Map<string, number> {
  return new Map(
    Object.entries(e).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] !== 0),
  );
}

/** `| bit | `0xMASK` | `Name` |` rows, as name -> mask; the bit must agree with the mask. */
function bitTable(heading: string): Map<string, number> {
  const rows = new Map<string, number>();
  for (const line of block(heading)) {
    const m = /^\|\s*(\d+)\s*\|\s*`0x([0-9A-Fa-f]+)`\s*\|\s*`(\w+)`/.exec(line);
    if (!m) continue;
    const mask = parseInt(m[2], 16);
    expect(mask, `${heading}: ${m[3]} bit ${m[1]} vs mask 0x${m[2]}`).toBe(1 << Number(m[1]));
    rows.set(m[3], mask);
  }
  return rows;
}

describe('SPEC.md matches the cache format code', () => {
  it('declares the current FORMAT_VERSION', () => {
    const m = /\*\*Current format version: (\d+)\*\*/.exec(spec);
    expect(m, 'SPEC.md must carry "**Current format version: N**"').not.toBeNull();
    expect(Number(m![1])).toBe(FORMAT_VERSION);
  });

  it('lists every HeaderFlags bit at its real position', () => {
    expect(bitTable('Header flags')).toEqual(members(HeaderFlags));
  });

  it('lists every GeometryChunkFlags bit at its real position', () => {
    expect(bitTable('Geometry chunk flags')).toEqual(members(GeometryChunkFlags));
  });

  it('ships in the published package, so the README link resolves on npm', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { files?: string[] };
    expect(pkg.files).toContain('SPEC.md');
  });

  it('lists every SectionType value', () => {
    const rows = new Map<string, number>();
    for (const line of block('Section types')) {
      const m = /^\|\s*(\d+)\s*\|\s*`(\w+)`/.exec(line);
      if (m) rows.set(m[2], Number(m[1]));
    }
    expect(rows).toEqual(members(SectionType));
  });
});
