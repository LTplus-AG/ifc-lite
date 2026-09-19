/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for `ifc-lite diff --by-content --geometry` (issue #4956).
 *
 * The scenario: two walls that carry the SAME `Name` and no `Tag` (so their
 * `dataHash` is identical — a single content bucket holding two candidates per
 * side) but different cross-sections (so their world geometry hashes are
 * distinct). Both are re-GUIDed in the head file.
 *
 * Without geometry the bucket is genuinely ambiguous: nothing in the
 * comparison tells the two candidates on one side apart, so the engine
 * correctly declines to guess (`ambiguous`, per #1923) and reports NO
 * `renamed` pair. `--geometry` sub-buckets by world geometry hash, which
 * resolves each candidate to its unique counterpart, and both come back
 * `renamed`.
 *
 * Skips (never fails) when `packages/wasm/pkg/ifc-lite_bg.wasm` is not built
 * on this host — see `pnpm build:wasm:fetch`.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { contentDiffCommand } from './diff-content.js';
import { guid } from './diff-test-helpers.js';

const WASM_PATH = fileURLToPath(
  new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url),
);
const WASM_AVAILABLE = existsSync(WASM_PATH);

/** Two walls sharing one `Name` (so `dataHash` matches — one content bucket
 *  with two candidates per side) but different rectangular cross-sections (so
 *  their world geometry hashes differ). */
function twinWallsModel(wallA: string, wallB: string): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCBUILDINGSTOREY('${guid('STOR')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#50= IFCLOCALPLACEMENT(#40,#21);
#62= IFCDIRECTION((0.,0.,1.));
#60= IFCRECTANGLEPROFILEDEF(.AREA.,$,#21,2.,0.2);
#61= IFCEXTRUDEDAREASOLID(#60,#21,#62,3.);
#63= IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#61));
#64= IFCPRODUCTDEFINITIONSHAPE($,$,(#63));
#65= IFCRECTANGLEPROFILEDEF(.AREA.,$,#21,2.,0.35);
#66= IFCEXTRUDEDAREASOLID(#65,#21,#62,3.);
#67= IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#66));
#68= IFCPRODUCTDEFINITIONSHAPE($,$,(#67));
#70= IFCWALL('${wallA}',$,'Wall',$,$,#50,#64,$,$);
#71= IFCWALL('${wallB}',$,'Wall',$,$,#50,#68,$,$);
#80= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RELC')}',$,$,$,(#70,#71),#41);
ENDSEC;
END-ISO-10303-21;
`;
}

const BASE_TWINS = twinWallsModel(guid('OLDA'), guid('OLDB'));
const HEAD_TWINS = twinWallsModel(guid('NEWA'), guid('NEWB'));

/**
 * Bitwise CRC32 (IEEE 802.3 / zlib polynomial `0xEDB88320`) — the checksum a
 * zip local/central file header carries per entry. `node:zlib`'s `crc32`
 * export needs Node >=20.15/22.2 (`@ifc-lite/cli`'s own `engines` floor is
 * Node >=18, see `package.json`), so this is a small local implementation
 * rather than a version-gated import. No lookup table: the fixture bytes are
 * a few hundred bytes, so the 8-bit-at-a-time cost is irrelevant here.
 */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Minimal single-entry, STORE-method (uncompressed) `.ifcZIP` container, built
 * by hand rather than pulling in a zip-writer dependency this package does not
 * otherwise need. `unwrapIfcZipView` (`@ifc-lite/parser`) only needs a
 * standards-compliant local file header + central directory + end-of-central-
 * directory record — the three parts below — over one entry whose name
 * matches `/\.(ifc|ifcxml)$/i`.
 */
function makeStoredIfcZip(entryName: string, content: string): Buffer {
  const data = Buffer.from(content, 'utf-8');
  const crc = crc32(data);
  const name = Buffer.from(entryName, 'utf-8');

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4); // version needed to extract
  localHeader.writeUInt16LE(0, 6); // flags
  localHeader.writeUInt16LE(0, 8); // method: 0 = store
  localHeader.writeUInt16LE(0, 10); // mod time
  localHeader.writeUInt16LE(0, 12); // mod date
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(data.length, 18); // compressed size == uncompressed (store)
  localHeader.writeUInt32LE(data.length, 22);
  localHeader.writeUInt16LE(name.length, 26);
  localHeader.writeUInt16LE(0, 28); // extra field length
  const localEntry = Buffer.concat([localHeader, name, data]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4); // version made by
  centralHeader.writeUInt16LE(20, 6); // version needed
  centralHeader.writeUInt16LE(0, 8); // flags
  centralHeader.writeUInt16LE(0, 10); // method
  centralHeader.writeUInt16LE(0, 12); // mod time
  centralHeader.writeUInt16LE(0, 14); // mod date
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(data.length, 20);
  centralHeader.writeUInt32LE(data.length, 24);
  centralHeader.writeUInt16LE(name.length, 28);
  centralHeader.writeUInt16LE(0, 30); // extra field length
  centralHeader.writeUInt16LE(0, 32); // comment length
  centralHeader.writeUInt16LE(0, 34); // disk number start
  centralHeader.writeUInt16LE(0, 36); // internal attrs
  centralHeader.writeUInt32LE(0, 38); // external attrs
  centralHeader.writeUInt32LE(0, 42); // local header offset
  const centralEntry = Buffer.concat([centralHeader, name]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir start disk
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(centralEntry.length, 12); // central dir size
  eocd.writeUInt32LE(localEntry.length, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localEntry, centralEntry, eocd]);
}

describe.runIf(WASM_AVAILABLE)('ifc-lite diff --by-content --geometry', () => {
  let dir: string;
  let basePath: string;
  let headPath: string;
  let stdoutSpy: MockInstance<typeof process.stdout.write>;
  let stderrSpy: MockInstance<typeof process.stderr.write>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ifclite-geometry-'));
    basePath = join(dir, 'v1.ifc');
    headPath = join(dir, 'v2.ifc');
    await writeFile(basePath, BASE_TWINS, 'utf-8');
    await writeFile(headPath, HEAD_TWINS, 'utf-8');
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  function stdoutJson(): {
    scope: string;
    counts: { added: number; modified: number; deleted: number; unchanged: number };
    contentMatches: { kind: string; base: string[]; head: string[] }[];
  } {
    return JSON.parse(stdoutSpy.mock.calls.map((c) => String(c[0])).join(''));
  }

  /** Every `renamed` match's (single) base key -> (single) head key, sorted by
   *  base key — the exact pairing, not just which four keys appeared. */
  function exactRenamedPairs(matches: { kind: string; base: string[]; head: string[] }[]): [string, string][] {
    return matches
      .map((match): [string, string] => {
        expect(match.kind).toBe('renamed');
        expect(match.base).toHaveLength(1);
        expect(match.head).toHaveLength(1);
        return [match.base[0], match.head[0]];
      })
      .sort(([a], [b]) => a.localeCompare(b));
  }

  it('cannot tell the twins apart without geometry: no renamed pair', async () => {
    await contentDiffCommand({ basePath, headPath, json: true });
    const result = stdoutJson();

    expect(result.scope).toBe('data');
    // Neither wall is retired: the engine declines to guess which head wall
    // corresponds to which base wall (issue #1923). `unchanged: 2` is the
    // project and storey, which share GlobalIds across the two files and so
    // match directly on the key-based pass before content matching runs.
    expect(result.counts).toEqual({ added: 2, modified: 0, deleted: 2, unchanged: 2 });
    expect(result.contentMatches).toHaveLength(1);
    expect(result.contentMatches[0].kind).toBe('ambiguous');
    expect(result.contentMatches[0].base.sort()).toEqual([guid('OLDA'), guid('OLDB')].sort());
    expect(result.contentMatches[0].head.sort()).toEqual([guid('NEWA'), guid('NEWB')].sort());
  }, 30_000);

  it('--geometry resolves both twins by world geometry hash: two renamed pairs', async () => {
    await contentDiffCommand({ basePath, headPath, geometry: true, json: true });
    const result = stdoutJson();

    expect(result.scope).toBe('both');
    expect(result.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 2 });
    // Not just "these four keys appeared somewhere" — OLDA and OLDB carry
    // DIFFERENT cross-sections (0.2 m / 0.35 m), and each head wall keeps its
    // base's cross-section, so the world geometry hash must pair each wall
    // with its OWN counterpart, not the other one.
    expect(exactRenamedPairs(result.contentMatches)).toEqual([
      [guid('OLDA'), guid('NEWA')],
      [guid('OLDB'), guid('NEWB')],
    ]);
  }, 30_000);

  it('--geometry over `.ifcZIP` inputs sees the unwrapped STEP bytes, not the zip container', async () => {
    // Same scenario, zipped. Before the review fix the wasm pass received the
    // raw (zipped) bytes `loadIfcBytes` unwraps internally but never hands
    // back — `buildPrePassOnce` over zip-container bytes finds no IFC jobs, so
    // geometry silently attached nothing and this fixture fell back to the
    // undistinguishable `ambiguous` result of the no-`--geometry` test above.
    const zipDir = await mkdtemp(join(tmpdir(), 'ifclite-geometry-zip-'));
    const zipBasePath = join(zipDir, 'v1.ifcZIP');
    const zipHeadPath = join(zipDir, 'v2.ifcZIP');
    await writeFile(zipBasePath, makeStoredIfcZip('model.ifc', BASE_TWINS));
    await writeFile(zipHeadPath, makeStoredIfcZip('model.ifc', HEAD_TWINS));

    await contentDiffCommand({
      basePath: zipBasePath,
      headPath: zipHeadPath,
      geometry: true,
      json: true,
    });
    const result = stdoutJson();

    expect(result.scope).toBe('both');
    expect(exactRenamedPairs(result.contentMatches)).toEqual([
      [guid('OLDA'), guid('NEWA')],
      [guid('OLDB'), guid('NEWB')],
    ]);
  }, 30_000);
});

describe('ifc-lite diff --by-content --geometry — wasm runtime absent', () => {
  it('skips gracefully with a stderr warning rather than failing the diff', async () => {
    // This test always runs (it does not need the real wasm runtime): it pins
    // that `--geometry` degrades to a warning plus data-scope output, which is
    // exactly what a host with no `.wasm` binary sees. On THIS host, whether
    // the runtime is actually present or not, the command must still finish
    // and print valid JSON — it may, or may not, also print the warning.
    const dir = await mkdtemp(join(tmpdir(), 'ifclite-geometry-absent-'));
    const basePath = join(dir, 'v1.ifc');
    const headPath = join(dir, 'v2.ifc');
    await writeFile(basePath, BASE_TWINS, 'utf-8');
    await writeFile(headPath, HEAD_TWINS, 'utf-8');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await contentDiffCommand({ basePath, headPath, geometry: true, json: true });
      const json = JSON.parse(stdoutSpy.mock.calls.map((c) => String(c[0])).join(''));
      expect(['data', 'both']).toContain(json.scope);
      if (json.scope === 'data') {
        const warnings = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(warnings).toContain('build:wasm:fetch');
      }
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  }, 30_000);
});
