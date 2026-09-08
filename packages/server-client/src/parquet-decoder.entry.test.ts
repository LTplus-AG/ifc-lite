// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The decoder is loaded against the parquet-wasm version this package
 * actually resolves, so the dead entry point cannot come back (#3845).
 *
 * `parquet-decoder.ts` imported `parquet-wasm/esm/arrow2.js`, a path
 * parquet-wasm dropped in 0.6, while the peer range said `>=0.5.0`. In-repo
 * that range auto-installed 0.5.0, where the path still existed, so every
 * existing test passed while any consumer on the version the rest of the
 * workspace pins (0.7.x) got a missing module at import time.
 *
 * The two halves below pin both directions of that mismatch:
 *  - the resolved version satisfies the declared peer range, and the dropped
 *    path is genuinely absent from it (a downgrade back to 0.5 fails here);
 *  - `decodeParquetGeometry` reads a real Parquet payload written by that same
 *    resolved version (re-introducing the deep import fails here, because the
 *    dynamic import inside `ensureParquetInit` no longer resolves).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { decodeParquetGeometry } from './parquet-decoder.js';

const require = createRequire(import.meta.url);

// apache-arrow's browser export map hides the `.d.ts` from TS's strict
// resolver, same as the modules under test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let arrow: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let parquet: any;

beforeAll(async () => {
  // The bare specifier is the point of this file: under Node the export map
  // picks the self-initializing Node build, which is exactly what
  // `ensureParquetInit()` imports.
  parquet = await import('parquet-wasm');
  arrow = await import('apache-arrow');
});

function readJson(path: string | URL): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * `^0.Y.Z` is pinned to the minor. That is the only shape this package's
 * parquet-wasm peer range takes (a 0.x caret), and the test below asserts
 * the range still has that shape rather than quietly mis-reading a `^1.x`.
 */
function satisfiesZeroMajorCaret(version: string, range: string): boolean {
  const [rMajor, rMinor, rPatch] = range.replace(/^\^/, '').split('.').map(Number);
  const [vMajor, vMinor, vPatch] = version.split('.').map(Number);
  return vMajor === rMajor && vMinor === rMinor && vPatch >= rPatch;
}

describe('parquet-wasm entry point', () => {
  it('resolves a version that satisfies the declared peer range', () => {
    const pkg = readJson(new URL('../package.json', import.meta.url));
    const range = (pkg.peerDependencies as Record<string, string>)['parquet-wasm'];
    // @source-text-assertion-ok shape guard, not a subject assertion: satisfiesZeroMajorCaret only reads a 0.x caret, so a `^1.x` range would let the check below pass vacuously
    expect(range.startsWith('^0.')).toBe(true);

    // Ask the resolver, not a hard-coded node_modules path: this resolves
    // the very entry point `import('parquet-wasm')` in the decoder gets.
    // Its manifest is read relatively because 0.7's export map does not
    // expose `./package.json` (resolving that subpath throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED), and every build entry it does expose
    // sits one directory below the package root (bundler/, esm/, node/).
    const manifest = readJson(new URL('../package.json', pathToFileURL(require.resolve('parquet-wasm'))));
    expect(manifest.name).toBe('parquet-wasm');
    const installed = manifest.version as string;
    expect(satisfiesZeroMajorCaret(installed, range)).toBe(true);
  });

  it('resolves the package entry point, not the arrow2 path dropped in 0.6', () => {
    expect(() => require.resolve('parquet-wasm/esm/arrow2.js')).toThrow();
    expect(typeof parquet.readParquet).toBe('function');
  });
});

/** Serialize an Arrow-JS Table to Parquet bytes via the resolved parquet-wasm,
 *  mirroring the server's writer path (packages/export/src/parquet-exporter.ts). */
function toParquetBytes(table: unknown): Uint8Array {
  const ipc = arrow.tableToIPC(table, 'stream');
  return new Uint8Array(parquet.writeParquet(parquet.Table.fromIPCStream(ipc)));
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function frame(sections: Uint8Array[]): ArrayBuffer {
  const chunks = sections.flatMap((bytes) => [u32le(bytes.length), bytes]);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}

/** One unit triangle, in the three-table standard geometry layout. */
function oneTriangleGeometry(): ArrayBuffer {
  const u32 = (values: number[]) => arrow.vectorFromArray(values, new arrow.Uint32());
  const f32 = (values: number[]) => arrow.vectorFromArray(values, new arrow.Float32());

  const meshTable = new arrow.Table({
    express_id: u32([42]),
    ifc_type: arrow.vectorFromArray(['IfcWall'], new arrow.Utf8()),
    vertex_start: u32([0]),
    vertex_count: u32([3]),
    index_start: u32([0]),
    index_count: u32([3]),
    color_r: f32([0.25]),
    color_g: f32([0.5]),
    color_b: f32([0.75]),
    color_a: f32([1]),
  });

  const vertexTable = new arrow.Table({
    x: f32([0, 1, 0]),
    y: f32([0, 0, 1]),
    z: f32([0, 0, 0]),
    nx: f32([0, 0, 0]),
    ny: f32([0, 0, 0]),
    nz: f32([1, 1, 1]),
  });

  const indexTable = new arrow.Table({ i0: u32([0]), i1: u32([1]), i2: u32([2]) });

  return frame([
    toParquetBytes(meshTable),
    toParquetBytes(vertexTable),
    toParquetBytes(indexTable),
  ]);
}

describe('decodeParquetGeometry against the resolved parquet-wasm', () => {
  it('decodes a payload written by that same version', async () => {
    const meshes = await decodeParquetGeometry(oneTriangleGeometry());

    expect(meshes).toHaveLength(1);
    const mesh = meshes[0];
    expect(mesh.express_id).toBe(42);
    expect(mesh.ifc_type).toBe('IfcWall');
    expect(Array.from(mesh.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2]);
    expect(mesh.color).toEqual([0.25, 0.5, 0.75, 1]);
  });
});
