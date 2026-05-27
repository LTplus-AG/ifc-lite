/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Download prebuilt @ifc-lite/wasm from npm when Rust/wasm-pack is unavailable.
 * Useful for Windows dev setups without WSL or a Rust toolchain.
 */

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const wasmPkgJson = JSON.parse(
  readFileSync(join(rootDir, 'packages/wasm/package.json'), 'utf8'),
);
const version = wasmPkgJson.version;
const tarball = `@ifc-lite/wasm@${version}`;

const wasmOut = join(rootDir, 'packages/wasm/pkg');
const threadedOut = join(rootDir, 'packages/wasm-threaded/pkg');
const wasmFile = join(wasmOut, 'ifc-lite_bg.wasm');

if (existsSync(wasmFile)) {
  console.log(`Prebuilt WASM already present at ${wasmFile}`);
  process.exit(0);
}

console.log(`Fetching ${tarball} from npm…`);
const tgzName = execSync(`npm pack ${tarball}`, {
  cwd: rootDir,
  encoding: 'utf8',
}).trim();

const extractDir = join(rootDir, '.wasm-fetch-tmp');
rmSync(extractDir, { recursive: true, force: true });
mkdirSync(extractDir, { recursive: true });

execSync(`tar -xzf ${JSON.stringify(join(rootDir, tgzName))} -C ${JSON.stringify(extractDir)}`, {
  cwd: rootDir,
  stdio: 'inherit',
});

mkdirSync(wasmOut, { recursive: true });
mkdirSync(threadedOut, { recursive: true });

const pkgDir = join(extractDir, 'package/pkg');
cpSync(pkgDir, wasmOut, { recursive: true, force: true });
cpSync(pkgDir, threadedOut, { recursive: true, force: true });

rmSync(extractDir, { recursive: true, force: true });
rmSync(join(rootDir, tgzName), { force: true });

console.log(`Installed prebuilt WASM to ${wasmOut}`);
patchThreadedDevStub(threadedOut);
console.log(`Patched threaded dev stub at ${threadedOut} (rebuild with Rust for real threading)`);

function patchThreadedDevStub(outDir) {
  const dtsPath = join(outDir, 'ifc-lite.d.ts');
  const jsPath = join(outDir, 'ifc-lite.js');
  let dts = readFileSync(dtsPath, 'utf8');
  if (!dts.includes('initThreadPool')) {
    dts += `

/**
 * Thread-pool initializer for the threaded WASM bundle.
 * Stubbed when prebuilt single-thread artifacts are used for local dev.
 */
export function initThreadPool(_numThreads?: number): Promise<void>;
`;
    writeFileSync(dtsPath, dts);
  }
  let js = readFileSync(jsPath, 'utf8');
  if (!js.includes('function initThreadPool')) {
    js = js.replace(
      'export { initSync };\nexport default __wbg_init;',
      'export { initSync };\nexport async function initThreadPool(_numThreads) {}\nexport default __wbg_init;',
    );
    writeFileSync(jsPath, js);
  }
}
