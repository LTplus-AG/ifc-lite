/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Download prebuilt @ifc-lite/wasm from npm when Rust/wasm-pack is unavailable.
 * Useful for Windows dev setups without WSL or a Rust toolchain.
 */

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tarballNameFromPackOutput } from './lib/npm-pack-output.mjs';
import { compareWasmExports } from './lib/wasm-export-parity.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const wasmPkgJson = JSON.parse(
  readFileSync(join(rootDir, 'packages/wasm/package.json'), 'utf8'),
);
const version = wasmPkgJson.version;
const tarball = `@ifc-lite/wasm@${version}`;

const wasmOut = join(rootDir, 'packages/wasm/pkg');
const wasmFile = join(wasmOut, 'ifc-lite_bg.wasm');

if (existsSync(wasmFile)) {
  console.log(`Prebuilt WASM already present at ${wasmFile}`);
  process.exit(0);
}

console.log(`Fetching ${tarball} from npm…`);
const tgzName = tarballNameFromPackOutput(
  execSync(`npm pack ${tarball} --json`, { cwd: rootDir, encoding: 'utf8' }),
);

const EXTRACT_DIR_NAME = '.wasm-fetch-tmp';
const extractDir = join(rootDir, EXTRACT_DIR_NAME);
rmSync(extractDir, { recursive: true, force: true });
mkdirSync(extractDir, { recursive: true });

// Relative paths, not absolute ones. GNU tar — what Git for Windows ships and
// what is first on PATH there — reads a leading `C:` as a REMOTE HOST and
// fails with "Cannot connect to C: resolve failed" before it opens anything.
// `--force-local` would fix that for GNU tar and break Windows' own bsdtar,
// which does not know the flag; running from `rootDir` with relative paths
// works for both and needs no branch on which tar is installed.
execSync(`tar -xzf ${JSON.stringify(tgzName)} -C ${JSON.stringify(EXTRACT_DIR_NAME)}`, {
  cwd: rootDir,
  stdio: 'inherit',
});

mkdirSync(wasmOut, { recursive: true });

const pkgDir = join(extractDir, 'package/pkg');

// Install only the runtime. `pkg/ifc-lite.d.ts` is COMMITTED and tracks this
// checkout's Rust crate; the published copy describes the last publish, so
// overwriting it dirties the tree and breaks the typecheck of anything built
// against newer bindings. The published .d.ts is used for nothing here.
const RUNTIME_FILES = ['ifc-lite_bg.wasm', 'ifc-lite.js'];
for (const name of RUNTIME_FILES) {
  copyFileSync(join(pkgDir, name), join(wasmOut, name));
}

rmSync(extractDir, { recursive: true, force: true });
rmSync(join(rootDir, tgzName), { force: true });

// The published runtime can predate this checkout (main merges Rust changes
// between publishes). A symbol the committed .d.ts declares and the fetched
// .js lacks type-checks, then fails in a bundler far from here, so name it now.
const committedDts = join(wasmOut, 'ifc-lite.d.ts');
if (existsSync(committedDts)) {
  const { missing, extra } = compareWasmExports(
    readFileSync(committedDts, 'utf8'),
    readFileSync(join(wasmOut, 'ifc-lite.js'), 'utf8'),
  );
  if (missing.length > 0) {
    // Leave no runtime behind: the "already present" early exit above would
    // otherwise accept this stale bundle on the next run.
    for (const name of RUNTIME_FILES) rmSync(join(wasmOut, name), { force: true });
    console.error(
      `\nThe published ${tarball} is behind this checkout (${checkoutCommit()}).\n` +
        `packages/wasm/pkg/ifc-lite.d.ts declares ${missing.length} export(s) the published runtime does not provide:\n` +
        missing.map((n) => `  - ${n}`).join('\n') +
        `\n\nThe fetched runtime was removed. Either build from source with a Rust toolchain ` +
        `(pnpm build:wasm), or wait for a publish that includes these exports.`,
    );
    process.exit(1);
  }
  if (extra.length > 0) {
    console.warn(
      `Warning: the published ${tarball} provides ${extra.length} export(s) this checkout's ` +
        `ifc-lite.d.ts does not declare (${extra.join(', ')}). The package is ahead of ` +
        `${checkoutCommit()}; harmless unless this checkout is stale.`,
    );
  }
}

console.log(`Installed prebuilt WASM runtime to ${wasmOut}`);

function checkoutCommit() {
  try {
    return `commit ${execSync('git rev-parse --short HEAD', { cwd: rootDir, encoding: 'utf8' }).trim()}`;
  } catch {
    return 'this checkout, commit unknown';
  }
}
