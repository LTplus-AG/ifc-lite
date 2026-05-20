/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Placeholder for the pre-bundled decode worker.
 *
 * In the source tree this file exports `null` — workspace dev (Vite's
 * `worker-import-meta-url` plugin via the viewer alias to `src/`) takes the
 * fallback path in `worker-client.ts` that spawns the worker from
 * `./decode-worker.ts`.
 *
 * At publish time, `scripts/build-worker-bundle.mjs` overwrites this file in
 * `dist/streaming/inline-worker.js` with the IIFE-bundled decode worker
 * source as a string constant. `worker-client.js` then loads it via a
 * dynamic `import()` and spawns the worker from a `Blob` URL — no
 * `type: 'module'`, no `import.meta.url` resolution, no consumer-side
 * `worker.format: 'es'` or `optimizeDeps.exclude` requirement.
 *
 * The dynamic import in `worker-client.ts` means bundlers code-split this
 * module out of the main chunk. Consumers who import the package but never
 * actually instantiate a decode worker don't pay the inline cost.
 */

export const INLINE_WORKER_CODE: string | null = null;
