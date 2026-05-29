/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared stub patcher for the threaded WASM bundle.
 *
 * When the threaded `pkg/` is produced without `wasm-bindgen-rayon` (either
 * because the local build skips threading or because we copied prebuilt
 * single-thread artifacts), the runtime still imports `initThreadPool`. This
 * appends a no-op so dev builds load without a ReferenceError; rebuilding
 * with Rust produces the real implementation.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_EXPORT_RE = /export\s+default\s+__wbg_init\s*;?/;
const STUB_DECL = `

/**
 * Thread-pool initializer for the threaded WASM bundle.
 * Stubbed when prebuilt single-thread artifacts are used for local dev.
 */
export function initThreadPool(_numThreads?: number): Promise<void>;
`;
const STUB_JS = 'export async function initThreadPool(_numThreads) {}\nexport default __wbg_init;';

export function patchThreadedDevStub(outDir) {
  const dtsPath = join(outDir, 'ifc-lite.d.ts');
  const jsPath = join(outDir, 'ifc-lite.js');
  if (!existsSync(dtsPath) || !existsSync(jsPath)) return;

  const dts = readFileSync(dtsPath, 'utf8');
  if (!dts.includes('initThreadPool')) {
    writeFileSync(dtsPath, dts + STUB_DECL);
  }

  const js = readFileSync(jsPath, 'utf8');
  if (!js.includes('function initThreadPool') && DEFAULT_EXPORT_RE.test(js)) {
    writeFileSync(jsPath, js.replace(DEFAULT_EXPORT_RE, STUB_JS));
  }
}
