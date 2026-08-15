#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Run every generated-file freshness gate locally, in one command, and
 * report ALL failures instead of stopping at the first.
 *
 * Why this exists: `check-api-surface.mjs` and `generate-bim-globals.mjs
 * --check` run inside the `node-tests` CI job BEFORE `pnpm test`, so a stale
 * generated file fails the job immediately and the whole test suite never
 * runs. The PR looks fine locally, then fails in CI minutes later with zero
 * test signal (this has happened on real PRs — see the PR description for
 * this change). Running the same gates before pushing catches it for free.
 *
 * Coverage — the five freshness gates in .github/workflows/test.yml:
 *   1. check:bim-globals        (node-tests, before `pnpm test`)
 *   2. check:api-surface        (node-tests, before `pnpm test`)
 *   3. check:server-attr-indices (node-tests, before `pnpm test`)
 *   4. plato clash-math freshness (plato-check job)          -- INFO only, see below
 *   5. committed wasm .d.ts vs Rust source (build job)        -- INFO only, see below
 *
 * (1)-(3) each need only a single-package `turbo build` (bim-globals ->
 * @ifc-lite/sandbox, server-attr-indices -> @ifc-lite/parser) or an
 * already-built `dist/` (api-surface, across all published packages) and run
 * in low tens of seconds, so they run unconditionally here.
 *
 * (4) and (5) are deliberately NOT run by default:
 *   - Plato clones `plato` + `ara3d-sdk` at pinned SHAs and does a `dotnet
 *     build` of Plato.CLI (needs the .NET 9 SDK) on first run. Minutes, plus
 *     a toolchain most contributors don't have installed.
 *   - The wasm gate needs a full wasm32 Rust rebuild (`bash
 *     scripts/build-wasm.sh`), which is minutes even warm and needs the Rust
 *     + wasm-pack toolchain.
 *   A check that slow would not get run before every push, which defeats the
 *   point (see the CLAUDE.md guidance this script was written against). So
 *   both print a reminder with the exact command instead of running it; pass
 *   `--full` to actually run them (only if the required toolchain is on
 *   PATH — otherwise this prints what's missing rather than pretending to
 *   pass).
 *
 * The api-surface gate reads BUILT `dist/*.d.ts` files. This script does NOT
 * run `pnpm build` first (that's the slow part — minutes, for the whole
 * workspace) — it uses whatever `dist/` is already on disk. If no package has
 * been built yet, that gate is SKIPPED with an explicit message rather than
 * failing (an unbuilt tree isn't "stale", it's just unbuilt). If `dist/` IS
 * present but older than the source that produced it, this can pass locally
 * and still fail in CI (CI always builds fresh) — that's a known, stated
 * limitation, not a silent gap. Pass `--build` to force a fresh `pnpm build`
 * first and close that gap when you want certainty.
 *
 * Usage:
 *   pnpm check:generated          # fast gates only (~seconds, if dist/ exists)
 *   pnpm check:generated --build  # + `pnpm build` first, so api-surface is certain
 *   pnpm check:generated --full   # + actually run plato/wasm gates (needs their toolchains)
 *
 * Exit code: non-zero if any gate FAILS. INFO/SKIP notices never fail the run.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_FIRST = process.argv.includes('--build');
const FULL = process.argv.includes('--full');

const results = [];

function hr() {
  console.log('─'.repeat(72));
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', ...opts });
}

function which(bin) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * True when EVERY published (non-private) packages/* has a dist/ directory.
 * A partial build (e.g. just @ifc-lite/sandbox, from check:bim-globals above)
 * still leaves check:api-surface unable to resolve most packages' entry
 * points — that's "not built yet", not "stale", and check-api-surface.mjs's
 * own "declaration entry is missing" branch is the authority on which
 * packages it needs; this is only a cheap pre-check to avoid printing that
 * whole wall of missing-entry names on an unbuilt tree.
 */
function allDistBuilt() {
  const pkgDir = join(ROOT, 'packages');
  if (!existsSync(pkgDir)) return false;
  return readdirSync(pkgDir).every((d) => {
    const pkgJson = join(pkgDir, d, 'package.json');
    if (!existsSync(pkgJson)) return true; // not a package dir
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
    } catch {
      return true;
    }
    if (pkg.private === true) return true;
    // @ifc-lite/wasm ships from a committed pkg/ dir, not a built dist/ —
    // its declarations are always "built" (see check-api-surface.mjs).
    return existsSync(join(pkgDir, d, 'dist')) || existsSync(join(pkgDir, d, 'pkg'));
  });
}

function record(name, status, detail, fix) {
  results.push({ name, status, detail, fix });
  const icon = { pass: '✅', fail: '❌', skip: '⏭️ ', info: 'ℹ️ ' }[status];
  console.log(`${icon} ${name}: ${status.toUpperCase()}`);
  if (detail) console.log(detail.trim().replace(/^/gm, '   '));
  if (fix) console.log(`   fix: ${fix}`);
}

function runGate(name, cmd, args, fix) {
  hr();
  console.log(`Running ${name}: ${[cmd, ...args].join(' ')}`);
  try {
    run(cmd, args);
    record(name, 'pass', null, null);
  } catch (e) {
    const output = [e.stdout, e.stderr].filter(Boolean).join('\n');
    record(name, 'fail', output || e.message, fix);
  }
}

hr();
console.log('ifc-lite: checking every generated-file freshness gate');
hr();

if (BUILD_FIRST) {
  console.log('--build: running `pnpm build` first (this is the slow part)…');
  try {
    run('pnpm', ['build']);
    console.log('✅ pnpm build succeeded');
  } catch (e) {
    console.log('❌ pnpm build failed — cannot evaluate check:api-surface reliably.');
    console.log((e.stdout || e.stderr || e.message).toString().trim().replace(/^/gm, '   '));
  }
}

// 1. Sandbox ambient types (bim-globals.d.ts) — single-package build, fast.
runGate(
  'check:bim-globals',
  'pnpm',
  ['run', 'check:bim-globals'],
  'pnpm generate:bim-globals   (then commit apps/viewer/src/lib/scripts/templates/bim-globals.d.ts)',
);

// 2. Server attr-indices — single-package build, fast.
runGate(
  'check:server-attr-indices',
  'pnpm',
  ['run', 'check:server-attr-indices'],
  'pnpm generate:server-attr-indices   (then `cargo fmt -p ifc-lite-server` and commit attr_indices.rs)',
);

// 3. API surface — needs the FULL workspace dist/, which this script does
// not build by default (see header comment).
if (!BUILD_FIRST && !allDistBuilt()) {
  record(
    'check:api-surface',
    'skip',
    'No packages/*/dist found — nothing built yet, so this gate has nothing to read.\n' +
      'This is a SKIP, not a pass: it proves nothing about whether the snapshot is stale.',
    'pnpm build && pnpm check:api-surface   (or re-run this script with --build)',
  );
} else {
  runGate(
    'check:api-surface',
    'pnpm',
    ['run', 'check:api-surface'],
    'pnpm api-surface:update   (then commit scripts/api-surface.json, and run `pnpm changeset` if the surface change is intentional)',
  );
  if (!BUILD_FIRST) {
    console.log(
      '   note: ran against whatever dist/ was already on disk (no rebuild). If you have\n' +
        '   uncommitted source changes since your last build, this can pass here and still\n' +
        '   fail in CI. Re-run with --build for a from-scratch answer.',
    );
  }
}

// 4. Plato clash-math freshness — INFO by default; needs .NET SDK + network.
if (FULL) {
  if (which('dotnet')) {
    runGate(
      'generate-plato-clash --check',
      'node',
      ['scripts/generate-plato-clash.mjs', '--check'],
      'node scripts/generate-plato-clash.mjs   (then commit rust/clash/src/generated/plato.rs and packages/clash/src/math/generated/plato.g.ts)',
    );
  } else {
    record(
      'generate-plato-clash --check',
      'fail',
      '--full was passed but `dotnet` is not on PATH — the .NET 9 SDK is required to run this gate.',
      'Install the .NET 9 SDK, or drop --full to skip this gate (see tools/plato/README.md).',
    );
  }
} else {
  record(
    'generate-plato-clash --check',
    'info',
    'Not run by default — needs the .NET 9 SDK and clones `plato` + `ara3d-sdk` at pinned SHAs on\n' +
      'first run (minutes, network). Only relevant if you touched tools/plato/**,\n' +
      'rust/clash/src/generated/**, or packages/clash/src/math/generated/**.',
    'node scripts/generate-plato-clash.mjs --check   (or re-run this script with --full)',
  );
}

// 5. Committed wasm .d.ts vs Rust source — INFO by default; needs a wasm rebuild.
if (FULL) {
  if (which('wasm-pack') && which('cargo')) {
    hr();
    console.log('Running wasm gate: bash scripts/build-wasm.sh && git diff --quiet -- packages/wasm/pkg/ifc-lite.d.ts');
    try {
      run('bash', ['scripts/build-wasm.sh']);
      try {
        run('git', ['diff', '--quiet', '--', 'packages/wasm/pkg/ifc-lite.d.ts']);
        record('wasm .d.ts freshness', 'pass', null, null);
      } catch {
        const diff = run('git', ['diff', '--', 'packages/wasm/pkg/ifc-lite.d.ts']);
        record(
          'wasm .d.ts freshness',
          'fail',
          diff,
          'Rebuild committed the drift above — `git add packages/wasm/pkg/ifc-lite.d.ts` and commit it.',
        );
      }
    } catch (e) {
      record(
        'wasm .d.ts freshness',
        'fail',
        (e.stdout || e.stderr || e.message).toString(),
        'bash scripts/build-wasm.sh failed — see output above.',
      );
    }
  } else {
    record(
      'wasm .d.ts freshness',
      'fail',
      '--full was passed but `cargo`/`wasm-pack` are not both on PATH.',
      'Install the Rust + wasm-pack toolchain (see .github/actions/setup-wasm-build), or drop --full.',
    );
  }
} else {
  record(
    'wasm .d.ts freshness',
    'info',
    'Not run by default — needs a full wasm32 Rust rebuild (minutes even warm) and the\n' +
      'Rust + wasm-pack toolchain. Only relevant if you touched rust/wasm-bindings/** or\n' +
      'anything it re-exports.',
    'bash scripts/build-wasm.sh && git diff --quiet -- packages/wasm/pkg/ifc-lite.d.ts   (or re-run this script with --full)',
  );
}

hr();
const failed = results.filter((r) => r.status === 'fail');
const skipped = results.filter((r) => r.status === 'skip');
const info = results.filter((r) => r.status === 'info');
const passed = results.filter((r) => r.status === 'pass');

console.log(
  `Summary: ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped, ${info.length} informational.`,
);

if (failed.length > 0) {
  console.log('\n❌ Stale generated file(s) — regenerate and commit before pushing:\n');
  for (const r of failed) {
    console.log(`  - ${r.name}`);
    if (r.fix) console.log(`      ${r.fix}`);
  }
  process.exit(1);
}

console.log('\n✅ Every gate that ran is clean.');
if (skipped.length > 0 || (info.length > 0 && !FULL)) {
  console.log('   (some gates were skipped/informational only — see notes above)');
}
