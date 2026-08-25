#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Module-size ratchet for TypeScript — the TS half of the rule that
 * `rust/processing/tests/module_size_ratchet.rs` already enforces for Rust.
 *
 * WHY THIS EXISTS: the Rust gate's `collect_rs_files` filters on
 * `extension == "rs"`, and the allowlist it reads is Rust-only, so the
 * AGENTS.md "split modules over ~400 non-generated lines" rule had *no*
 * executable enforcement at all on the TypeScript side. That gap has already
 * demonstrated itself: `packages/export/src/step-serialization.ts` was taken
 * to 389 lines by #2507 and drifted back over 400 with nothing to stop it
 * (#2475). A redesign that splits a god file re-grows unless something holds
 * the new shape.
 *
 * The gate has two teeth, identical to the Rust one:
 *  1. A NEW non-generated, non-test TS/TSX file that crosses 400 lines and has
 *     no allowlist row fails. This is the load-bearing guarantee: no new god
 *     files.
 *  2. An allowlisted file that GROWS past its recorded budget fails. Existing
 *     debt is frozen; a listed file may stay flat or shrink, never grow.
 *
 * Shrinking a file to <= 400 lets you delete its row, and the gate says so.
 * Budgets ratchet DOWN only: shrink or split instead of raising one.
 *
 * WIRED INTO CI in the node-tests job of .github/workflows/test.yml, next to
 * the other source-shape gates. The initial allowlist grandfathers 312 files
 * and embodies a judgement about what counts as production TypeScript.
 *
 * The allowlist is a SNAPSHOT of the tree it was recorded from, so growth that
 * lands on main afterwards — from any PR, including ones this branch never
 * touched — makes the gate red on a long-lived branch. After any merge from
 * main, run the script; if it reports a listed file past budget or a new file
 * over 400, the allowlist needs refreshing in the same commit. Do that with
 * `pnpm lint:module-size-baseline` rather than by hand. A refresh that only
 * tracks growth already on main is a maintainer call and must be stated in the
 * PR; it is not licence to raise a budget for growth the PR itself introduced,
 * which is why the regeneration command refuses a raise unless asked twice.
 *
 * What the step breaks on afterwards, by design: any PR adding a TS/TSX file
 * over 400 lines, any PR growing a listed file past its recorded budget, and
 * any PR editing the allowlist without moving ALLOWLIST_DIGEST — including a
 * rebase that lands after someone else's shrink, which requires recomputing
 * the pin. It does NOT break on a file shrinking or disappearing; those are
 * advisory notes.
 *
 * WHAT THIS GATE CANNOT SEE: it counts lines, nothing else. A 400-line file
 * doing five jobs passes; a cohesive 900-line table fails. It does not look at
 * .js/.mjs/.cjs, at anything outside packages/ and apps/, at generated,
 * declaration or test files, or at whether a "split" merely moved lines into a
 * sibling file. Freezing a size is not the same as enforcing a design.
 *
 * Run: node scripts/check-module-size.mjs
 * Regenerate: pnpm lint:module-size-baseline   (node scripts/check-module-size.mjs --update)
 *
 * An absolute-budget ratchet fights a moving main by construction: any
 * long-lived branch accumulates a red made of files it never touched, and a
 * contributor reading a list of unfamiliar filenames reasonably concludes the
 * gate is noise. `--update` is the supported way to re-record, so that
 * hand-editing the allowlist stops being the only one — a hand-edited ratchet
 * is one distracted afternoon from someone raising a budget instead of
 * splitting a file, which is the exact thing this gate exists to prevent.
 *
 * `--update` refuses, by itself, to do the one thing that would make it a
 * loophole: it will not raise a budget or add a new exemption. Those need
 * `--allow-raise` on the command line, so the loosening is a deliberate act
 * that shows up in the shell history and still costs a reviewable line in the
 * digest pin. `check-unused-locals.mjs --update` has no such safeguard.
 *
 * Flags (development and the test harness only; CI would pass none):
 *   --root <dir>       scan this tree instead of the repo
 *   --allowlist <path> read this allowlist instead of the committed one
 *   --digest <value>   compare against this pin instead of ALLOWLIST_DIGEST
 *   --update           rewrite the allowlist and the digest pin from the tree
 *   --allow-raise      with --update, permit budget raises and new exemptions
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIMIT,
  countLines,
  isExempt,
  parseAllowlist,
  allowlistDigest,
  evaluate,
  staleRows,
  planUpdate,
  renderAllowlist,
} from './lib/module-size-ratchet.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, '..');

/** Trees walked. `apps/server` is a Rust crate and contributes no TS files. */
const SEARCH_DIRS = ['packages', 'apps'];

/** Build output, vendored code and caches — never hand-written modules. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'pkg',
  'build',
  'coverage',
  '.turbo',
  '.next',
  'target',
  '.git',
]);

const SOURCE_RE = /\.(ts|tsx|mts|cts)$/;

/**
 * Digest of every `(path, budget)` pair in the allowlist, pinned HERE rather
 * than in the allowlist itself: a figure derived from the file it guards is
 * circular and always passes.
 *
 * Tooth 2 above has an escape hatch that is invisible in its own output —
 * raising a budget in the SAME commit that grows the file satisfies it. That
 * is exactly how a raise reached main on the Rust side and had to be undone
 * afterwards (#2658), which is why that gate grew this pin and why this one
 * is born with it.
 *
 * A plain SUM is not enough: raising one budget by 100 while lowering another
 * by 100 leaves the total unchanged. The digest moves for ANY change to ANY
 * row, so loosening the ratchet always costs one reviewable line here.
 *
 * TO RECOMPUTE: `pnpm lint:module-size-baseline`, which rewrites the allowlist
 * and this constant together. By hand: set this to '0', run
 * `node scripts/check-module-size.mjs`, and read the true value out of the
 * failure message. Either way do it at the moment you finalise the change — it
 * moves if anything else touched the allowlist first.
 */
const ALLOWLIST_DIGEST = '5792675369521145557';

function parseArgs(argv) {
  const out = {
    root: REPO_ROOT,
    allowlist: null,
    digest: ALLOWLIST_DIGEST,
    update: false,
    allowRaise: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--root' || flag === '--allowlist' || flag === '--digest') {
      if (value === undefined) fail(`${flag} needs a value`);
      out[flag.slice(2)] = value;
      i += 1;
    } else if (flag === '--update') {
      out.update = true;
    } else if (flag === '--allow-raise') {
      out.allowRaise = true;
    } else {
      fail(`unknown argument: ${flag}`);
    }
  }
  // `--allow-raise` alone reads as "budgets may go up" and does nothing, which
  // is the worst way for a safety flag to behave. Refuse it instead.
  if (out.allowRaise && !out.update) fail('--allow-raise only means something with --update');
  if (out.allowlist === null) out.allowlist = join(out.root, 'scripts', 'module-size-allowlist.txt');
  return out;
}

function fail(message) {
  console.error(`check-module-size: ${message}`);
  process.exit(1);
}

/**
 * Fail closed on an unreadable directory. Swallowing one would let the gate
 * report success without having looked at the file that broke the rule — the
 * "passes having verified nothing" shape this whole family of scripts exists
 * to avoid.
 */
function walk(dir, found) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    fail(`cannot read directory ${dir}: ${err.message}`);
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    // Dirent.isDirectory() is false for a symlinked directory; stat follows it.
    const isDir = entry.isDirectory() || (entry.isSymbolicLink() && safeIsDir(full));
    if (isDir) walk(full, found);
    else if (SOURCE_RE.test(entry.name)) found.push(full);
  }
  return found;
}

function safeIsDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const args = parseArgs(process.argv.slice(2));

let allowlistText;
try {
  allowlistText = readFileSync(args.allowlist, 'utf8');
} catch (err) {
  fail(`cannot read allowlist ${args.allowlist}: ${err.message}`);
}

let allowlist;
try {
  allowlist = parseAllowlist(allowlistText, args.allowlist);
} catch (err) {
  fail(err.message);
}

if (!/^\d+$/.test(String(args.digest))) {
  fail(
    'no digest pin. ALLOWLIST_DIGEST in scripts/check-module-size.mjs must be a decimal ' +
      'u64 string; set it to 0 and run this script to read the true value from the failure.',
  );
}

// Every search root must exist and must be a directory. A glob that resolved
// to nothing is the classic vacuous pass, so it is an error, never a skip.
const paths = [];
for (const dir of SEARCH_DIRS) {
  const full = join(args.root, dir);
  if (!safeIsDir(full)) fail(`search root ${full} does not exist or is not a directory`);
  walk(full, paths);
}

const files = paths
  .map((p) => ({ rel: relative(args.root, p).split('\\').join('/'), path: p }))
  .filter(({ rel }) => !isExempt(rel))
  .map(({ rel, path }) => ({ rel, lines: countLines(readFileSync(path, 'utf8')) }));

if (files.length === 0) {
  fail(
    `no TypeScript files matched under ${SEARCH_DIRS.join(', ')} in ${args.root}. ` +
      'Exiting 0 here would certify a tree nobody looked at.',
  );
}

if (args.update) {
  const { next, raised, added, lowered, removed } = planUpdate(files, allowlist);

  const loosening = [...raised, ...added];
  if (loosening.length > 0 && !args.allowRaise) {
    fail(
      `refusing to loosen the ratchet.\n\n` +
        (raised.length > 0
          ? `Allowlisted file(s) now PAST their budget — recording the new count is a raise:\n\n${raised.join('\n')}\n\n`
          : '') +
        (added.length > 0
          ? `File(s) over ${LIMIT} lines with no row — recording them is a new exemption:\n\n${added.join('\n')}\n\n`
          : '') +
        `Shrink or split them (AGENTS.md house rule). If the growth is genuinely\n` +
        `justified, say why in the PR and re-run with --allow-raise; the digest pin\n` +
        `still makes it one reviewable line.\n\n` +
        `Nothing was written.`,
    );
  }

  if (next.size === 0) {
    fail(
      `refusing to write an allowlist with 0 rows: ${files.length} files measured and none ` +
        `over ${LIMIT} lines. That is either a genuinely clean tree — in which case delete ` +
        `the allowlist deliberately — or a --root that scanned the wrong place.`,
    );
  }

  writeFileSync(args.allowlist, renderAllowlist(allowlistText, next));

  // The pin lives in this script, not in the allowlist (see ALLOWLIST_DIGEST):
  // a digest stored beside the rows it guards is circular. Rewrite it here so
  // the regeneration is one command, not one command plus a hand edit that the
  // next reader has to remember.
  const nextDigest = allowlistDigest(next);
  const selfPath = join(args.root, 'scripts', 'check-module-size.mjs');
  const PIN_RE = /^const ALLOWLIST_DIGEST = '\d+';$/m;
  let pinned = false;
  try {
    const selfText = readFileSync(selfPath, 'utf8');
    if (PIN_RE.test(selfText)) {
      writeFileSync(selfPath, selfText.replace(PIN_RE, `const ALLOWLIST_DIGEST = '${nextDigest}';`));
      pinned = true;
    }
  } catch {
    // --root points at a synthetic tree (the test harness does exactly this),
    // so there is no pin to move. Print the value instead of pretending.
  }

  for (const row of lowered) console.log(`lowered:${row}`);
  for (const row of removed) console.log(`removed:${row}`);
  for (const row of raised) console.log(`RAISED:${row}`);
  for (const row of added) console.log(`ADDED:${row}`);
  console.log(
    `check-module-size: wrote ${next.size} rows to ${args.allowlist} ` +
      `(${lowered.length} lowered, ${removed.length} removed, ${raised.length} raised, ${added.length} added).`,
  );
  console.log(
    pinned
      ? `check-module-size: ALLOWLIST_DIGEST re-pinned to ${nextDigest} in ${selfPath}. Commit both.`
      : `check-module-size: no ALLOWLIST_DIGEST pin found under ${args.root}; the new digest is ${nextDigest}.`,
  );
  process.exit(0);
}

let failed = false;

const actualDigest = allowlistDigest(allowlist);
if (actualDigest !== String(args.digest)) {
  failed = true;
  const total = [...allowlist.values()].reduce((a, b) => a + b, 0);
  console.error(`
The allowlist digest is ${actualDigest} (${allowlist.size} rows, budgets total ${total}),
but ALLOWLIST_DIGEST in scripts/check-module-size.mjs reads ${args.digest}.

Raising a budget loosens this ratchet, so it must be visible in review: set
ALLOWLIST_DIGEST to ${actualDigest} in the SAME commit and say in the PR why the
module cannot be split. Lowering a budget or deleting a row is welcome and must
update the digest too, so the pin keeps stating the real allowlist.
`);
}

const stale = staleRows(allowlist);
if (stale.length > 0) {
  failed = true;
  console.error(`
Allowlist rows at or under the ${LIMIT}-line limit (delete them — a row that
grants no exemption is permanent slack, not debt):\n
${stale.join('\n')}
`);
}

const { newOffenders, grew, shrunk, missing, slack } = evaluate(files, allowlist);

if (newOffenders.length > 0) {
  failed = true;
  console.error(`
New TypeScript file(s) over ${LIMIT} lines with no allowlist row:\n
${newOffenders.join('\n')}

Split them (AGENTS.md house rule), or — only with a written justification in
the PR — add a row to scripts/module-size-allowlist.txt and update
ALLOWLIST_DIGEST in the same commit.
`);
}

if (grew.length > 0) {
  failed = true;
  console.error(`
Allowlisted file(s) grew PAST their recorded budget. Shrink or split instead of
raising the budget:\n
${grew.join('\n')}
`);
}

// Advisory: never fails the build, so a shrink landing in another PR cannot
// turn this one red. Mirrors the Rust gate's advisory notes.
for (const row of shrunk) {
  console.log(`note: ${row.trim()} <= ${LIMIT}; delete its allowlist row (the total must trend down)`);
}
for (const row of missing) {
  console.log(`note:${row} no longer matches a tracked file (gone, renamed or now exempt); remove it`);
}
// Advisory: headroom a file can grow into with nothing firing. Not a failure,
// because a shrink landing in another PR would otherwise turn this one red —
// but it must be VISIBLE, or the ratchet quietly stops being one for that row.
for (const row of slack) {
  console.log(`note:${row}; lower the budget to the measured count (and re-pin the digest)`);
}

if (failed) process.exit(1);

console.log(
  `check-module-size: OK (${files.length} files measured, ${allowlist.size} allowlisted, 0 new over ${LIMIT})`,
);
