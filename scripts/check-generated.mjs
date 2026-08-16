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
 * Coverage was originally claimed as "the five freshness gates in
 * .github/workflows/test.yml" — that claim was wrong. PR #2632 (a brand-new
 * package, @ifc-lite/oauth-pkce) hit two more generated/baseline gates this
 * script didn't run — `generate-docs-sections.mjs --check` (node-tests) and
 * `check-unused-locals.mjs` (Lint) — and both fast-failed CI with zero test
 * signal, exactly the failure mode this script exists to catch locally. The
 * fix at the time re-derived the list from every step in the `build` / `lint`
 * / `node-tests` jobs — but that scope was itself the bug: it named three
 * jobs instead of the whole workflow, so `rust-tests`' own `cargo metadata
 * --locked` gate (same shape, same "fails before any test signal" cost) sat
 * unaudited and uncovered until a #2631 review caught it (issue #2631).
 *
 * That correction was still not complete. It missed `pnpm install
 * --frozen-lockfile` — the JS twin of the cargo gate, comparing
 * pnpm-lock.yaml against every workspace package.json — which is the FIRST
 * real step of seven of the eleven jobs (test.yml lines 206, 312, 342, 375,
 * 512, 687, 730) and fails in under a second with zero test signal from any
 * of them. It was neither run nor listed as a deliberate exclusion (#2664
 * review). It is gate 1 below, and it runs first here because it runs first
 * there.
 *
 * The list below is re-derived from every STEP of all ELEVEN jobs in
 * .github/workflows/test.yml (`changes`, `build`, `typecheck`, `lint`,
 * `node-tests`, `viewer-e2e`, `rust-tests`, `geometry-census`, `plato-check`,
 * `docs-checks`, `test`) — not a chosen subset of jobs, which is how each of
 * the previous two versions of this list went wrong. `changes` contributes
 * nothing: its three steps are a checkout, a paths-filter and a shell probe
 * that writes a job output, none of which compare a committed artifact
 * against its source.
 * (numbered in the order this script runs them, which is how the inline
 * comments below refer to them)
 *   1. pnpm install --frozen-lockfile (build/typecheck/lint/node-tests/
 *      viewer-e2e/plato-check/docs-checks — first real step of each)
 *   2. check:bim-globals         (node-tests, before `pnpm test`)
 *   3. check:server-attr-indices (node-tests, before `pnpm test`)
 *   4. generate-docs-sections.mjs --check (node-tests, before `pnpm test`;
 *      also docs-checks — the docs-only-PR twin of the same command)
 *   5. check-unused-locals.mjs   (lint job, via `pnpm lint`)
 *   6. check:api-surface         (node-tests, before `pnpm test`)
 *   7. cargo metadata --locked   (rust-tests job, before Clippy/`cargo test`)
 *   8. plato clash-math freshness (plato-check job)          -- INFO only, see below
 *   9. committed wasm .d.ts vs Rust source (build job)        -- INFO only, see below
 *
 * Steps deliberately NOT treated as a generated-artifact gate here, and why:
 *   - `pnpm fixtures:check` (build job) compares downloaded test-fixture
 *     checksums against tests/models/manifest.json. Not derived from repo
 *     source — there's nothing in this repo to regenerate it from — and it
 *     needs the ~1GB fixture set on disk. Wrong shape for a pre-push script.
 *   - `check-changesets.mjs`, `check-lint-ran.mjs`, `check-test-wiring.mjs`,
 *     `check-package-readmes.mjs` (docs/), `check-doc-samples.mjs` (docs/):
 *     structural/policy checks (a script ran, a file exists, a changeset
 *     names a real package) — nothing generated, nothing to regenerate.
 *   - `check-source-text-assertions.mjs` and `check-wasm-disposal.mjs`
 *     (node-tests): ratchets against an allowlist, but the allowlist is
 *     hand-maintained (no `--update` / generator) — a violation means "don't
 *     add that pattern", not "stale file, regenerate it". No fix command to
 *     offer, so out of scope for this script.
 *   - `check-unbounded-frame-wait.mjs` (node-tests): scans for an absent
 *     pattern, no baseline file at all.
 *   - `pnpm --filter=@ifc-lite/viewer check:templates` (node-tests):
 *     typechecks against bim-globals.d.ts (gate 2's output) but doesn't
 *     itself compare a generated artifact — covered transitively by gate 2.
 *   - `check-server-bin-targets.mjs` and its regression harness
 *     (`check-server-bin-targets.test.mjs`, `lib/server-bin-targets-parse.test.mjs`,
 *     node-tests): cross-checks three hand-maintained lists (platform.ts,
 *     package.json, server-binaries.yml) against each other for parity —
 *     nothing is regenerated from source into a committed artifact, so
 *     there is nothing to diff.
 *   - `scripts/lib/unused-locals-classify.test.mjs` (node-tests, added by the
 *     sibling #2634 follow-up branch): a unit test of gate 5's own parsing
 *     logic, not a gate over generated content.
 *   - `scripts/typecheck-tests.test.mjs` (node-tests): likewise a unit test —
 *     it pins the `extends` path typecheck-tests.mjs writes, which gate 5
 *     depends on, but it compares nothing committed.
 *   - `pnpm typecheck` (typecheck job) = `turbo typecheck` plus
 *     `typecheck-tests.mjs --audit`. The audit GENERATES the tsconfig program
 *     it checks, on the fly, from the test files it finds on disk — nothing is
 *     committed for it to go stale against. It's a coverage gate ("every test
 *     file is a root file of some program"), not a freshness gate.
 *   - The `build` job's `pnpm build` / `pnpm fixtures` / prebuilt-WASM fetch,
 *     the `viewer-e2e` job in full, node-tests' `pnpm test`,
 *     `pnpm test:integration` and `pnpm test:wasm-contract`, and the final
 *     `test` aggregator job: no generated-artifact comparison in any of them.
 *   - The geometry-census job's `Census` step (`cargo test -p
 *     ifc-lite-geometry --features triangulation-alt --test
 *     triangulation_invariance`): checks a live sweep against a checked-in
 *     golden (tests/manifests/watertightness_census.tsv), which is the same
 *     shape as (8)/(9) below in spirit, but its own job comment documents
 *     re-blessing as a manual "run, download the uploaded artifact, replace
 *     the golden" workflow — no `--check`-style command this script could
 *     invoke — and the sweep itself costs ~20 minutes over the ~1.4GB
 *     fixture corpus, the same cost class that keeps (8) and (9) opt-in.
 *     Left out rather than added half-wired.
 *   - The `changes` job's paths-filter and prebuilt-WASM-eligibility probe:
 *     they route the workflow, they don't compare a committed artifact
 *     against the source it came from.
 *   - The `test` aggregator job's single "Gate on dependencies" step: it
 *     reads the other jobs' results, runs nothing of its own.
 *   - The other jobs' setup/plumbing steps (checkout, pnpm/Node/Rust/.NET
 *     setup, cargo + fixture caches, `rustup show`, artifact upload/download):
 *     no artifact comparison in any of them.
 *
 * (1)-(7) each need only a lockfile resolve (frozen-lockfile), a
 * single-package `turbo build` (bim-globals -> @ifc-lite/sandbox,
 * server-attr-indices -> @ifc-lite/parser), an already-built `dist/` across
 * all published packages (api-surface, unused-locals), or nothing at all
 * (docs-sections, cargo metadata), and run in well under two minutes total,
 * so they run unconditionally here — (7) is SKIPPED rather than run when
 * `cargo` isn't on PATH, since a frontend-only contributor's machine may not
 * have the Rust toolchain installed at all, and an absent binary is not
 * evidence of a stale lockfile. (2)-(4) are likewise SKIPPED on a tree with
 * no node_modules: they shell out through `pnpm run`, and without an install
 * they fail with `Command "turbo" not found`, which this script used to
 * report under the headline "Stale generated file(s) — regenerate and
 * commit". That named the wrong cause and offered a fix that could not
 * possibly work (#2664 review). (1) deliberately has no such precondition —
 * it is exactly the gate that still works, and still matters, on an
 * uninstalled tree.
 *
 * (8) and (9) are deliberately NOT run by default:
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

/**
 * True when the workspace has been installed at all.
 *
 * The gates that shell out through `pnpm run` reach `turbo` (and every other
 * dev dependency) via the root node_modules. On a fresh clone that has never
 * been installed they fail with `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command
 * "turbo" not found` — which this script reported under the headline "Stale
 * generated file(s) — regenerate and commit before pushing", naming a cause
 * that isn't the cause and offering a `pnpm generate:*` fix that fails the
 * same way (#2664 review). An uninstalled tree isn't stale, it's uninstalled;
 * gates 5 and 6 already had exactly this kind of precondition and this gives
 * the earlier ones theirs.
 */
function nodeModulesInstalled() {
  return existsSync(join(ROOT, 'node_modules'));
}

function record(name, status, detail, fix) {
  results.push({ name, status, detail, fix });
  const icon = { pass: '✅', fail: '❌', skip: '⏭️ ', info: 'ℹ️ ' }[status];
  console.log(`${icon} ${name}: ${status.toUpperCase()}`);
  if (detail) console.log(detail.trim().replace(/^/gm, '   '));
  if (fix) console.log(`   fix: ${fix}`);
}

function runGate(name, cmd, args, fix, opts = {}) {
  hr();
  console.log(`Running ${name}: ${[cmd, ...args].join(' ')}`);
  try {
    run(cmd, args, opts);
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
    console.log('❌ pnpm build failed — cannot evaluate check:api-surface / check-unused-locals reliably.');
    console.log((e.stdout || e.stderr || e.message).toString().trim().replace(/^/gm, '   '));
  }
}

// 1. pnpm-lock.yaml is in sync with every workspace package.json. This is
// the JS twin of gate 7's `cargo metadata --locked`, and the one with the
// widest blast radius in CI: `pnpm install --frozen-lockfile` is the FIRST
// real step of seven of the eleven jobs in test.yml (build, typecheck, lint,
// node-tests, viewer-e2e, plato-check, docs-checks), so a package.json edited
// without regenerating the lockfile turns all seven red before a single test
// runs. It costs ~0.2s to catch here.
//
// `--lockfile-only` makes this a pure verification: pnpm resolves and
// compares, and never touches node_modules. Combined with `--frozen-lockfile`
// it also cannot rewrite pnpm-lock.yaml — frozen-lockfile errors out before
// any write on drift, and on a clean tree there is nothing to write. Verified
// both ways against a `git status` that stayed empty.
//
// Unlike gates 2-4 below this needs NO node_modules, so it is the one gate
// that still gives a real answer on a fresh clone.
runGate(
  'pnpm-lock.yaml freshness',
  'pnpm',
  ['install', '--frozen-lockfile', '--lockfile-only'],
  'pnpm install   (then commit pnpm-lock.yaml; `pnpm install --lockfile-only` if you want the lockfile without touching node_modules)',
);

// 2-4 shell out through `pnpm run`, so they need the workspace installed —
// without it they report a missing `turbo` as a stale generated file.
if (!nodeModulesInstalled()) {
  record(
    'check:bim-globals / check:server-attr-indices / docs:check-generated',
    'skip',
    'No root node_modules — these gates run through `pnpm run`, which cannot resolve\n' +
      '`turbo` or the generators on an uninstalled tree. This is a SKIP, not a pass:\n' +
      'nothing was compared, so nothing is known about whether these files are stale.',
    'pnpm install   (then re-run this script)',
  );
} else {
  // 2. Sandbox ambient types (bim-globals.d.ts) — single-package build, fast.
  runGate(
    'check:bim-globals',
    'pnpm',
    ['run', 'check:bim-globals'],
    'pnpm generate:bim-globals   (then commit apps/viewer/src/lib/scripts/templates/bim-globals.d.ts)',
  );

  // 3. Server attr-indices — single-package build, fast.
  runGate(
    'check:server-attr-indices',
    'pnpm',
    ['run', 'check:server-attr-indices'],
    'pnpm generate:server-attr-indices   (then `cargo fmt -p ifc-lite-server` and commit attr_indices.rs)',
  );

  // 4. Generated doc sections (docs/api/typescript.md package index,
  // docs/guide/cli.md, docs/guide/performance.md, apps/landing/app.jsx) — no
  // build needed, reads package.json/source directly. Fast (well under a
  // second). This is the gate PR #2632 actually hit: a new package's row was
  // missing from the package-index region.
  runGate(
    'docs:check-generated',
    'pnpm',
    ['run', 'docs:check-generated'],
    'pnpm docs:generate   (then commit the regenerated doc file(s))',
  );
}

// 5. Unused-locals baseline (scripts/unused-locals-baseline.json) — a
// package added but never `pnpm lint:baseline`-d silently has no ratchet at
// all (this is the OTHER gate PR #2632 hit). Like api-surface, this
// type-checks every package against its siblings' BUILT dist/ types, so it
// shares the same "needs dist/" precondition — reuse allDistBuilt() below.
if (!BUILD_FIRST && !allDistBuilt()) {
  record(
    'check-unused-locals',
    'skip',
    'No packages/*/dist found — nothing built yet, so this gate has nothing to\n' +
      'type-check siblings against. This is a SKIP, not a pass.',
    'pnpm build && node scripts/check-unused-locals.mjs   (or re-run this script with --build)',
  );
} else {
  runGate(
    'check-unused-locals',
    'node',
    ['scripts/check-unused-locals.mjs'],
    'pnpm lint:baseline   (then commit scripts/unused-locals-baseline.json)',
  );
  if (!BUILD_FIRST) {
    console.log(
      '   note: ran against whatever dist/ was already on disk (no rebuild) — same\n' +
        '   caveat as check:api-surface above. Re-run with --build for a from-scratch answer.',
    );
  }
}

// 6. API surface — needs the FULL workspace dist/, which this script does
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

// 7. Cargo.lock is in sync with the manifests (rust-tests job). Cheap
// (resolve only, no compile), and it fails BEFORE Clippy or `cargo test` run
// — the same "zero test signal" shape as gates 1-5, just missed at first
// because the original version of this script only audited the build/lint/
// node-tests jobs (#2631 review). Skipped, not failed, when `cargo` is not
// on PATH: this repo's frontend-only contributors don't necessarily have
// the Rust toolchain installed, and CI's own rust-tests job only runs when
// the `rust` path filter fires, so an absent binary here proves nothing
// about staleness.
if (which('cargo')) {
  runGate(
    'cargo metadata --locked',
    'cargo',
    ['metadata', '--locked', '--format-version', '1'],
    'cargo update -p <the crate whose Cargo.toml you edited> --workspace   (or, if a release bumped every manifest, re-run scripts/sync-versions.js) — then commit Cargo.lock',
    // `cargo metadata` prints the FULL resolved dependency graph as JSON on
    // stdout — ~1.9 MB in this workspace as of writing, and only growing —
    // and execFileSync's default 1MB maxBuffer throws ENOBUFS on that
    // before cargo even gets to report a real lock-file mismatch. The
    // 64MB below is headroom, not a measurement. The CI step avoids this by piping
    // to /dev/null; this script needs the buffer instead, since it wants
    // the text back on failure.
    { maxBuffer: 64 * 1024 * 1024 },
  );
} else {
  record(
    'cargo metadata --locked',
    'skip',
    'cargo is not on PATH — nothing to run this gate against. CI\'s rust-tests\n' +
      'job runs it unconditionally whenever rust/**, Cargo.toml, or Cargo.lock changed.',
    'Install the Rust toolchain (see rust-toolchain.toml), or re-run this script once it is on PATH.',
  );
}

// 8. Plato clash-math freshness — INFO by default; needs .NET SDK + network.
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

// 9. Committed wasm .d.ts vs Rust source — INFO by default; needs a wasm rebuild.
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
