/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Download prebuilt @ifc-lite/wasm from npm when Rust/wasm-pack is unavailable.
 * Useful for Windows dev setups without WSL or a Rust toolchain.
 *
 * Usage: node scripts/fetch-prebuilt-wasm.mjs [--force]
 *
 * The runtime (ifc-lite.js + ifc-lite_bg.wasm) is checked against the
 * COMMITTED ifc-lite.d.ts both when it is fetched and when one is already
 * installed. `--force` re-fetches even if a runtime is installed; the existing
 * runtime is replaced only if the fetched one passes the check.
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

const force = process.argv.includes('--force');
const committedDts = join(wasmOut, 'ifc-lite.d.ts');
const RUNTIME_FILES = ['ifc-lite_bg.wasm', 'ifc-lite.js'];

if (existsSync(wasmFile) && !force) {
  console.log(`Prebuilt WASM already present at ${wasmFile}`);
  // An installed runtime may have been fetched before this check existed, or
  // by an older checkout, or built before the Rust sources moved on. Check it
  // like a fresh fetch, but never delete it: its origin is unknown and it may
  // be a source build.
  const installedJs = join(wasmOut, 'ifc-lite.js');
  if (!existsSync(installedJs)) {
    console.error(
      `\n${wasmFile} is present but ${installedJs} is missing, so the runtime is incomplete.\n` +
        `Rebuild from source (pnpm build:wasm) or re-fetch with: node scripts/fetch-prebuilt-wasm.mjs --force`,
    );
    process.exit(1);
  }
  const parity = parityAgainstCommittedDts(readFileSync(installedJs, 'utf8'));
  if (parity.missing.length > 0) {
    console.error(
      `\nThe installed WASM runtime in ${wasmOut} is behind this checkout (${checkoutCommit()}).\n` +
        listMissing(parity.missing) +
        `\n\nThe installed runtime was left untouched. Either build from source with a Rust toolchain ` +
        `(pnpm build:wasm), or re-fetch ${tarball} with: node scripts/fetch-prebuilt-wasm.mjs --force ` +
        `(replaces the installed runtime only if the published one passes this check; ` +
        `the published package may itself be behind).`,
    );
    process.exit(1);
  }
  warnExtra(parity.extra);
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
//
// The published runtime can predate this checkout (main merges Rust changes
// between publishes). A symbol the committed .d.ts declares and the fetched
// .js lacks type-checks, then fails in a bundler far from here, so name it
// BEFORE installing anything: a stale bundle is never left behind for the
// "already present" early exit to accept, and under --force the previously
// installed runtime survives a failed fetch.
const fetchedParity = parityAgainstCommittedDts(readFileSync(join(pkgDir, 'ifc-lite.js'), 'utf8'));
if (fetchedParity.missing.length > 0) {
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(join(rootDir, tgzName), { force: true });
  console.error(
    `\nThe published ${tarball} is behind this checkout (${checkoutCommit()}).\n` +
      listMissing(fetchedParity.missing) +
      `\n\nNothing was installed. Either build from source with a Rust toolchain ` +
      `(pnpm build:wasm), or wait for a publish that includes these exports.`,
  );
  process.exit(1);
}

for (const name of RUNTIME_FILES) {
  copyFileSync(join(pkgDir, name), join(wasmOut, name));
}

rmSync(extractDir, { recursive: true, force: true });
rmSync(join(rootDir, tgzName), { force: true });

warnExtra(fetchedParity.extra);

console.log(`Installed prebuilt WASM runtime to ${wasmOut}`);

function checkoutCommit() {
  try {
    return `commit ${execSync('git rev-parse --short HEAD', { cwd: rootDir, encoding: 'utf8' }).trim()}`;
  } catch {
    return 'this checkout, commit unknown';
  }
}

/** Exports the committed .d.ts declares vs those `js` provides; empty if there is no committed .d.ts. */
function parityAgainstCommittedDts(js) {
  if (!existsSync(committedDts)) return { missing: [], extra: [] };
  return compareWasmExports(readFileSync(committedDts, 'utf8'), js);
}

function listMissing(missing) {
  return (
    `packages/wasm/pkg/ifc-lite.d.ts declares ${missing.length} export(s) the runtime does not provide:\n` +
    missing.map((n) => `  - ${n}`).join('\n')
  );
}

function warnExtra(extra) {
  if (extra.length === 0) return;
  console.warn(
    `Warning: the runtime provides ${extra.length} export(s) this checkout's ` +
      `ifc-lite.d.ts does not declare (${extra.join(', ')}). The package is ahead of ` +
      `${checkoutCommit()}; harmless unless this checkout is stale.`,
  );
}
