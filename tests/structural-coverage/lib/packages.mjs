/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The product code the probes call, imported from each package's built
 * `dist/`, after a Turbo build brings it up to date. A failed build is a harness
 * error, never a probe result: an unbuilt checkout must not read as "the
 * product cannot do it".
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boundedSpawnSync } from '../../../scripts/lib/bounded-process.mjs';

const PACKAGES = ['parser', 'mutations', 'create', 'export'];
const BUILD = ['turbo', 'build', '--filter=@ifc-lite/parser...', '--filter=@ifc-lite/create...', '--filter=@ifc-lite/export...'];

export async function loadPackages(root) {
  // Let turbo validate source/dependency hashes and rebuild or restore current
  // output. Merely finding dist/ can silently score an earlier checkout. The
  // wasm runtime is the exception: build-wasm.sh keeps the pkg/ on disk when
  // wasm-pack is absent, so a Rust edit needs a wasm toolchain to be scored.
  const build = boundedSpawnSync('pnpm', BUILD, {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 20 * 60 * 1000,
  });
  if (build.status !== 0 || build.error) {
    throw new Error(`structural coverage package build failed${build.error ? ` (${build.error.message})` : ''}:\n${build.stdout ?? ''}\n${build.stderr ?? ''}`);
  }
  const missing = PACKAGES.filter((p) => !existsSync(join(root, `packages/${p}/dist/index.js`)));
  if (missing.length) {
    throw new Error(`pnpm ${BUILD.join(' ')} produced no dist/index.js for ${missing.map((p) => `@ifc-lite/${p}`).join(', ')}`);
  }
  const load = (p) => import(pathToFileURL(join(root, `packages/${p}/dist/index.js`)).href);
  const [parser, mutations, create, exporter] = await Promise.all(PACKAGES.map(load));
  // The glyph builder is a subpath of its own, kept off the parser index so it loads lazily in the viewer.
  const structuralGlyphs = await import(pathToFileURL(join(root, 'packages/parser/dist/structural-glyphs.js')).href);
  return { parser, mutations, create, exporter, structuralGlyphs };
}

/** Memoise `make()` in the run's cache under `key`. */
export function cached(ctx, key, make) {
  if (!ctx.cache.has(key)) ctx.cache.set(key, make());
  return ctx.cache.get(key);
}

/** The parsed store of one corpus file, parsed once per run and shared by the probes. */
export const storeOf = (ctx, file) => cached(ctx, `store:${file.path}`, () => parseStore(ctx.pkgs, file.bytes));

/** Parse STEP bytes or text into an IfcDataStore, the way the product tests do. */
export async function parseStore(pkgs, input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new pkgs.parser.IfcParser().parseColumnar(buffer, { disableWorkerScan: true });
}
