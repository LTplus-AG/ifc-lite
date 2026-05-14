#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Post-`tsc` transform for `dist/geometry-controller.worker.js` (issue #676).
 *
 * Why this exists
 * ---------------
 * The controller worker statically imports `@ifc-lite/wasm-threaded` in source
 * so the workspace build (Vite alias → packages/wasm-threaded/pkg/ifc-lite.js)
 * keeps working — Vite only honors aliases for statically-analyzable
 * specifiers, and the controller is opted into at runtime via
 * `localStorage['ifc-lite:single-controller']='1'` in the viewer.
 *
 * The published `@ifc-lite/geometry` package is a different story. The
 * threaded WASM bundle is workspace-only (see
 * `packages/wasm-threaded/package.json` `_intent`), so consumers don't have
 * it in their node_modules. When their bundler (Turbopack, webpack, esbuild)
 * chunks the controller worker, it statically follows the `from
 * '@ifc-lite/wasm-threaded'` import and fails with `Module not found: Can't
 * resolve '@ifc-lite/wasm-threaded'` — even when `useSingleController` is
 * never enabled. ocni-dtu hit this on Next 16 + Turbopack (#676).
 *
 * Marking the dep as an optional peerDependency (PR #665) doesn't help here
 * — that flag is read by `pnpm install`, not by bundlers. The only way to
 * make the dependency truly optional at the consumer's *build step* is to
 * remove the static reference from the published JS.
 *
 * What this transform does
 * ------------------------
 * Replaces the single static-import line in `dist/geometry-controller.worker.js`:
 *
 *   import init, { initSync, IfcAPI, initThreadPool } from '@ifc-lite/wasm-threaded';
 *
 * with module-level `let` bindings plus a lazy loader that builds the
 * specifier at call time (so neither Turbopack's nor webpack's nor
 * esbuild's static-import detector picks it up). Also injects an
 * `await __loadThreadedModule()` at the top of the `init` message handler
 * so the bindings are populated before the worker's first WASM call.
 *
 * Hosts that opt into `useSingleController` in their published-bundle
 * context must alias `@ifc-lite/wasm-threaded` themselves; without that
 * alias the dynamic import fails at runtime (with a clear error message),
 * not at build time.
 *
 * Idempotent: re-running on an already-transformed file is a no-op.
 * Strict: throws if the anchor patterns aren't found, so a tsc emit shape
 * change can't silently regress the contract — `geometry-controller-dist.test.ts`
 * also pins the result.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distFile = resolve(__dirname, '../dist/geometry-controller.worker.js');

if (!existsSync(distFile)) {
  console.error(`[transform-controller-worker-dist] missing ${distFile} — did tsc run?`);
  process.exit(1);
}

const original = readFileSync(distFile, 'utf8');

// Idempotency: presence of the loader marker means we've already transformed.
const LOADER_MARKER = '__loadThreadedModule';
if (original.includes(LOADER_MARKER)) {
  console.log('[transform-controller-worker-dist] already transformed; nothing to do.');
  process.exit(0);
}

// The exact line tsc emits. If tsc rearranges the import (e.g., separates
// default from named) the transform must update accordingly — the strict
// check below catches that.
const STATIC_IMPORT_RE =
  /^import init, \{ initSync, IfcAPI, initThreadPool \} from '@ifc-lite\/wasm-threaded';$/m;

if (!STATIC_IMPORT_RE.test(original)) {
  console.error(
    '[transform-controller-worker-dist] expected static import line not found in ' +
    `${distFile}. The tsc emit shape may have changed — update this script and ` +
    'packages/geometry/src/geometry-controller-dist.test.ts together.',
  );
  process.exit(1);
}

// Replacement for the static import: module-scoped `let` bindings + a
// lazy loader that's safe to call repeatedly. The specifier is built via
// Array.join so static-import detectors leave it alone.
const replacement = `// Issue #676: scripts/transform-controller-worker-dist.mjs replaces the
// source-level static import of '@ifc-lite/wasm-threaded' with this lazy
// loader so consumer bundlers (Turbopack / webpack / esbuild) don't try
// to resolve a package that is workspace-only by design. See the source
// file for the full rationale.
let init, initSync, IfcAPI, initThreadPool;
let __threadedModulePromise = null;
async function __loadThreadedModule() {
    if (__threadedModulePromise) return __threadedModulePromise;
    // Specifier built at call time so static-import scanners can't see it.
    const __specifier = ['@ifc-lite', 'wasm-threaded'].join('/');
    __threadedModulePromise = (async () => {
        try {
            const m = await import(/* webpackIgnore: true */ /* @vite-ignore */ __specifier);
            init = m.default;
            initSync = m.initSync;
            IfcAPI = m.IfcAPI;
            initThreadPool = m.initThreadPool;
            return m;
        } catch (err) {
            __threadedModulePromise = null;
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(
                '[controller] failed to load @ifc-lite/wasm-threaded (' + detail + '). ' +
                'The single-controller path requires the threaded WASM bundle. ' +
                "Alias '@ifc-lite/wasm-threaded' to packages/wasm-threaded/pkg/ifc-lite.js " +
                "in your bundler config (see viewer's vite.config.ts Phase 2 wiring), " +
                'or omit useSingleController to stay on the N-worker fallback.',
            );
        }
    })();
    return __threadedModulePromise;
}`;

let next = original.replace(STATIC_IMPORT_RE, replacement);

// Inject `await __loadThreadedModule();` at the top of the `init` message
// handler. tsc emits the handler with indentation (4 spaces × 3 levels) —
// match the open-brace line so we land right inside the block.
const INIT_HANDLER_RE = /^( {12})if \(e\.data\.type === 'init'\) \{$/m;

if (!INIT_HANDLER_RE.test(next)) {
  console.error(
    "[transform-controller-worker-dist] expected `if (e.data.type === 'init') {` " +
    'block at 12-space indent not found. The tsc emit shape may have changed.',
  );
  process.exit(1);
}

next = next.replace(
  INIT_HANDLER_RE,
  (_match, indent) => `${indent}if (e.data.type === 'init') {\n${indent}    // Lazily resolve '@ifc-lite/wasm-threaded' before its bindings are used.\n${indent}    await __loadThreadedModule();`,
);

if (next === original) {
  console.error('[transform-controller-worker-dist] transform produced no changes — aborting.');
  process.exit(1);
}

writeFileSync(distFile, next);
console.log(`[transform-controller-worker-dist] rewrote ${distFile} (issue #676)`);
