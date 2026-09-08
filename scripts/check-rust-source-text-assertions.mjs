#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GATE for issue #3195: AGENTS.md's "never assert on a source file's text" was
 * unenforced across the whole `rust/` tree.
 *
 * `scripts/check-source-text-assertions.mjs` enforces that rule for `packages/`
 * and `apps/`. It also covers `scripts/` since #3639, but never Rust: its
 * detector parses JavaScript, so a Rust test is invisible to it whatever the
 * scan scope says.
 *
 * The maintainer demonstrated the consequence rather than inferring it: a genuine
 * source-text assertion (`fs::read_to_string("src/api/space_plate_input.rs")`
 * plus a `contains`) planted in a real Rust test left the gate exiting 0
 * without naming the file (#3129).
 *
 * Run: `node scripts/check-rust-source-text-assertions.mjs`
 * (also `pnpm check:rust-source-text-assertions`).
 *
 * ## SIBLING GATE, not an extension of the TypeScript one
 *
 * The issue offered two shapes and asked the maintainer to choose: fold a Rust
 * pass into the existing script, or ship a sibling. He had not answered when
 * this was built, so it is the sibling -- the issue's own stated
 * recommendation -- and it is REVERSIBLE: the detector is a module with the
 * same `analyze(text, relPath)` shape the TypeScript one has, so merging the
 * two later is a call-site change, not a rewrite.
 *
 * The reason for the sibling is precision. The TypeScript detector's value is
 * that it reads filenames out of a real TypeScript parse tree, which is what
 * stops a comment naming `safe-path.test.ts` from being mistaken for an
 * assertion. Rust has no parser here, so its detector is a hand-written lexer
 * with the same PROPERTIES but none of the same code. Putting both in one file
 * would invite a later "unification" that quietly regresses whichever one loses
 * -- and the property at risk is the one three false positives were already
 * paid for.
 *
 * ## What it flags
 *
 * A read (`include_str!`, `include_bytes!`, `fs::read`, `fs::read_to_string`,
 * `File::open`) inside test code, whose path is spelled by a string literal
 * with a SOURCE extension. Fixture reads -- `.ifc`, `.ifcx`, `.json`, a golden
 * manifest -- are out of scope by construction rather than by exclusion; see
 * scripts/lib/rust-source-text-detect.mjs, which carries the full design and
 * the limitations.
 *
 * ## Vacuity
 *
 * Directly on point, and not hypothetical: three sibling gates were fixed days
 * ago (#3194 / PR #3197) for passing green while scanning zero files, and
 * `check-test-glob-coverage` was reproduced printing
 * `OK (0 packages audited, 0 unrun test files)` with `EXIT=0`. So this one
 * fails loudly on a missing scan root, a root with no `.rs` files, zero test
 * files found, and a total read count below READ_FLOOR. The floor is the one
 * that matters: a detector that silently stops matching (the lexer edited, a
 * call name renamed) drops to zero reads and would otherwise report a clean
 * tree, which is exactly the failure this whole family of issues is about.
 */

import { readdirSync, readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, isTestPath } from './lib/rust-source-text-detect.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Scan root. The whole `rust/` tree, deliberately: the TypeScript gate's
 * mistake was a scope narrower than the rule it enforces, and repeating that
 * one crate at a time would be the same defect in a smaller box. Every crate
 * under `rust/` carries tests.
 */
const SCAN_ROOTS = ['rust'];

/** Build output and vendored trees hold no first-party tests. */
const SKIP_DIRS = new Set(['target', 'node_modules', 'pkg', 'dist', 'build']);

/**
 * Lower bound on how many file reads the detector must still find in Rust test
 * code. NOT a ceiling on violations (that bound is zero, enforced separately)
 * -- this exists so the gate cannot pass by having stopped detecting anything.
 *
 * Measured at 108 reads across 413 files carrying test code on cd9405b52. Set
 * to 90, a margin wide enough that ordinary churn does not force an edit, and
 * narrow enough that a broken lexer -- every break measured while building this
 * dropped the count to zero or near it -- still fails. If a real refactor
 * removes reads, lower this in the same commit, which makes "this PR reduced
 * the gate's reach" a reviewable line in the diff.
 */
const READ_FLOOR = 90;

/**
 * Allowlist for whole files that cannot be converted. EMPTY, and expected to
 * stay empty: the tree has zero source-text assertions in Rust today, so a row
 * here is a deliberate statement that a Rust test certifies a string rather
 * than a behaviour. Prefer the per-site `// @source-text-assertion-ok <reason>`
 * marker, which stays NAMED in this gate's output. Format, one path per line.
 */
const ALLOWLIST_PATH = join(ROOT, 'scripts', 'rust-source-text-assertion-allowlist.txt');

/**
 * Exact allowlist size, recorded HERE rather than in the allowlist: a ceiling
 * derived from the file it guards is circular and always passes. Both
 * directions fail, matching check-source-text-assertions.mjs and
 * check-refwalk-guards.mjs, so growth must show up as an edit to this line.
 */
const ALLOWLIST_CEILING = 0;

/**
 * Fails closed on an unreadable directory: swallowing it would let the gate
 * report success without having looked at the file that broke the rule.
 *
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]}
 */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.rs')) out.push(full);
  }
  return out;
}

/**
 * @param {string} path
 * @returns {Set<string>}
 */
function loadAllowlist(path) {
  if (!existsSync(path)) return new Set();
  return new Set(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(Boolean)
  );
}

/**
 * The whole check, as a function of a base directory, so its own tests can run
 * it against a synthetic tree instead of the repo.
 *
 * @param {string} base
 * @param {{ roots?: string[], allowlist?: Set<string>, readFloor?: number, allowlistCeiling?: number }} [opts]
 * @returns {{ ok: boolean, errors: string[], reads: number, files: number, testFiles: number, offenders: string[], marked: string[], deadMarkers: string[] }}
 */
export function runCheck(base, opts = {}) {
  const roots = opts.roots ?? SCAN_ROOTS;
  const allowlist = opts.allowlist ?? loadAllowlist(ALLOWLIST_PATH);
  const readFloor = opts.readFloor ?? READ_FLOOR;
  const allowlistCeiling = opts.allowlistCeiling ?? ALLOWLIST_CEILING;

  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const offenders = [];
  /** @type {string[]} */
  const marked = [];
  /** @type {string[]} */
  const deadMarkers = [];
  const stale = new Set(allowlist);
  let reads = 0;
  let files = 0;
  let testFiles = 0;

  for (const root of roots) {
    const abs = join(base, root);
    if (!existsSync(abs)) {
      errors.push(
        `scan root missing: ${root}. The gate has nothing to check, which is a failure, not a pass — fix the path or remove the root.`
      );
      continue;
    }
    const found = walk(abs);
    if (found.length === 0) {
      errors.push(`scan root ${root} contains no .rs files. Refusing to report success on an empty input set.`);
      continue;
    }
    files += found.length;
    for (const file of found) {
      const rel = relative(base, file).split('\\').join('/');
      const text = readFileSync(file, 'utf8');
      // Cheap pre-filter, so the lexer only runs where a test can live. It has
      // to agree with the detector's own scope decision, so both consult
      // `isTestPath` and the same `#[cfg(test)]` spelling.
      if (!isTestPath(rel) && !/#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/.test(text)) continue;
      testFiles++;
      const result = analyze(text, rel);
      reads += result.reads;
      for (const line of result.unusedMarkers) deadMarkers.push(`${rel}:${line}`);
      for (const site of result.marked) marked.push(`${rel}:${site.line}  ${site.path}  ${site.reason}`);
      if (result.hits.length === 0) continue;
      if (allowlist.has(rel)) {
        stale.delete(rel);
        continue;
      }
      for (const hit of result.hits) offenders.push(`${rel}:${hit.line}  ${hit.call} of ${hit.path}`);
    }
  }

  if (testFiles === 0 && errors.length === 0) {
    errors.push(
      `found ${files} .rs files but not one test file among them. A tree with no tests to check is not a clean tree — refusing a vacuous pass.`
    );
  }
  if (reads < readFloor) {
    errors.push(
      `only ${reads} file reads found in Rust test code, floor is ${readFloor}. Either the detector stopped working (check scripts/lib/rust-source-text-detect.mjs) or the reads were genuinely removed — if removed, lower READ_FLOOR in the same commit.`
    );
  }
  if (stale.size > 0) {
    errors.push(
      `allowlisted files that no longer contain a source-text assertion (converted or deleted — remove the lines):\n  ${[...stale].join('\n  ')}`
    );
  }
  if (allowlist.size !== allowlistCeiling) {
    errors.push(
      `allowlist has ${allowlist.size} entries but ALLOWLIST_CEILING reads ${allowlistCeiling}. Adding a row is a deliberate loosening of this gate and must be visible in review: edit the constant in the same commit. Removing one must lower it, or the ceiling drifts into slack.`
    );
  }

  return {
    ok: errors.length === 0 && offenders.length === 0 && deadMarkers.length === 0,
    errors,
    reads,
    files,
    testFiles,
    offenders,
    marked,
    deadMarkers,
  };
}

/**
 * Is this module the process entry point?
 *
 * Comparing resolved PATHS rather than URLs, for the reason spelled out at
 * length in scripts/check-refwalk-guards.mjs: `import.meta.url` is
 * percent-encoded and resolved through symlinks, `process.argv[1]` is neither,
 * so the obvious spelling fails on a checkout path containing a space and on
 * macOS's `/var` -> `/private/var` symlink — silently, leaving the gate green
 * having scanned nothing.
 *
 * @returns {boolean}
 */
function isMainEntry() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(self) === realpathSync(invoked);
  } catch {
    return self === resolve(invoked);
  }
}

if (isMainEntry()) {
  const result = runCheck(ROOT);

  if (result.offenders.length > 0) {
    console.error('\nSource-text assertions found in Rust test code:\n');
    for (const o of result.offenders) console.error(`  ${o}`);
    console.error(`
Each of these reads a SOURCE file from a test. That certifies a string exists,
not that the code works — it stays green while the behaviour underneath it is
broken, and goes red on a harmless rename (AGENTS.md, "Never assert on a source
file's text"; the measured case is #2396, where a wiring test stayed 5/5 green
with the row handler replaced by a no-op).

Write a behavioural test instead: call the function, feed it the input that
would exercise the string you were grepping for, and assert on what comes back.

If the read is a MUTATION ANCHOR — asserting the anchor exists before a
rewrite is built on it, so a rewrite that silently stops applying cannot leave
the test asserting nothing — mark that site instead:

  // @source-text-assertion-ok mutation anchor guard, not a subject assertion
  let src = std::fs::read_to_string("../src/lib.rs").unwrap();

Marked sites stay NAMED in this check's output; they are not exemptions in the
dark. A whole file that cannot be converted at all goes in
scripts/rust-source-text-assertion-allowlist.txt, which requires raising
ALLOWLIST_CEILING in the same commit.
`);
  }

  if (result.deadMarkers.length > 0) {
    console.error(`\n${'@source-text-assertion-ok'} markers that excuse nothing:\n`);
    for (const d of result.deadMarkers) console.error(`  ${d}`);
    console.error(`
Either the marker has no reason after it, or the read it excused is gone, moved
or no longer names a source file. A marker sits inside the read's enclosing
statement, on the line above where that statement starts, or trailing on the
read's own line.
`);
  }

  for (const e of result.errors) console.error(`\nrust-source-text-assertions: ${e}`);

  if (!result.ok) process.exit(1);

  for (const site of result.marked) {
    console.log(`  marked @source-text-assertion-ok: ${site}`);
  }
  console.log(
    `check-rust-source-text-assertions: OK (${result.files} .rs files, ${result.testFiles} with test code, ${result.reads} reads examined, 0 source-text assertions)`
  );
}
