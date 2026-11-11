/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The product code the probes call, imported from each package's built
 * `dist/`. A missing build is a harness error with the build command, never a
 * probe result: an unbuilt checkout must not read as "the product cannot do it".
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGES = ['parser', 'mutations', 'create', 'export'];

export async function loadPackages(root) {
  const missing = PACKAGES.filter((p) => !existsSync(join(root, `packages/${p}/dist/index.js`)));
  if (missing.length) {
    throw new Error(
      `packages not built: ${missing.map((p) => `@ifc-lite/${p}`).join(', ')}.\n`
        + '  build: pnpm turbo build --filter=@ifc-lite/parser... --filter=@ifc-lite/create... --filter=@ifc-lite/export...',
    );
  }
  const load = (p) => import(pathToFileURL(join(root, `packages/${p}/dist/index.js`)).href);
  const [parser, mutations, create, exporter] = await Promise.all(PACKAGES.map(load));
  return { parser, mutations, create, exporter };
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
