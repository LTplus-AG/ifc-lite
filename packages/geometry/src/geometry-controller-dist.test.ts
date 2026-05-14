/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression pin for issue #676: the published `geometry-controller.worker.js`
 * must NOT contain a static `import … from '@ifc-lite/wasm-threaded'` statement.
 *
 * Why: the threaded bundle is workspace-only (see
 * packages/wasm-threaded/package.json `_intent`), but the controller worker
 * ships in every consumer's bundle because Turbopack / webpack / Vite chunk
 * worker URLs at build time. A static import would force every consumer to
 * resolve `@ifc-lite/wasm-threaded` even when `useSingleController` is off —
 * exactly the build failure ocni-dtu reported on Next 16 + Turbopack.
 *
 * The runtime path uses a dynamic import with an indirect specifier
 * (concatenated at call time) so bundlers can't statically resolve the
 * target. This test asserts the build output preserves that contract.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const distControllerJs = resolve(__dirname, '../dist/geometry-controller.worker.js');

describe('#676 controller worker is bundler-safe for consumers without @ifc-lite/wasm-threaded', () => {
  // Skip the body when dist isn't built locally — CI runs the build before
  // tests, so the regression coverage holds where it matters.
  const distAvailable = existsSync(distControllerJs);
  const maybe = distAvailable ? it : it.skip;

  maybe('dist/geometry-controller.worker.js has no static `from "@ifc-lite/wasm-threaded"` import', () => {
    const src = readFileSync(distControllerJs, 'utf8');
    // Static-import detection: any `import … from "@ifc-lite/wasm-threaded"`
    // (single OR double quotes). Allow dynamic `import(<expr>)` and string
    // literals inside comments / error messages.
    const staticImport = /\bimport\b[^;]*?\bfrom\s+['"]@ifc-lite\/wasm-threaded['"]/;
    expect(staticImport.test(src)).toBe(false);
  });

  maybe('controller still references the threaded module via dynamic import', () => {
    // Smoke check: the loader function survives the build so consumers who
    // opt into useSingleController can still resolve via bundler alias.
    const src = readFileSync(distControllerJs, 'utf8');
    expect(src).toMatch(/await import\(/);
    expect(src).toMatch(/wasm-threaded/);
  });
});
