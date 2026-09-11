#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Module-size ratchet for TypeScript and Node scripts — the non-Rust half of
 * the rule that `rust/processing/tests/module_size_ratchet.rs` already
 * enforces for Rust.
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
 *  1. A NEW non-generated, non-test TS/TSX/MJS/CJS file that crosses 400 lines
 *     and has no allowlist row fails. This is the load-bearing guarantee: no
 *     new god files.
 *  2. An allowlisted file that GROWS past its recorded budget fails. Existing
 *     debt is frozen; a listed file may stay flat or shrink, never grow.
 *
 * Shrinking a file to <= 400 lets you delete its row, and the gate says so.
 * Budgets ratchet DOWN by default: prefer shrinking or splitting to raising
 * one. A raise is not forbidden, it is deliberate -- `--update --allow-raise`,
 * justified per file in the PR -- and the allowlist header says the same. The
 * two must keep saying the same thing: a reviewer reaches whichever copy sits
 * in the file they are editing, and #3398 was filed because they disagreed.
 *
 * THERE IS NO DIGEST PIN (removed by #3745). Earlier revisions stored a
 * per-scope hash of the allowlist's rows in this file (`ALLOWLIST_DIGESTS`)
 * so that any edit to a row had to move a second, separately-committed line.
 * That pin is a pure function of the allowlist's own content — deriving it
 * from the file it guards and then storing the derived value back in a
 * DIFFERENT file bought nothing a reviewer could read (a 20-digit FNV-1a hash
 * says nothing about whether a raise is justified; the allowlist row diff
 * already says that, in plain English, on its own) — while costing real
 * contention: 316 of 362 rows sit at zero headroom, so most PRs touching an
 * allowlisted file rewrote their scope's single pinned line, and two PRs in
 * the SAME scope always collided there even when their row edits were on
 * disjoint, non-adjacent lines (#3745). It caused two red mains (#3689/#3723,
 * #3712/#3735) and three separate branch conflicts in one evening. The two
 * teeth above are unchanged and still the only things that fail the gate; the
 * allowlist row diff is still visible in every PR, exactly as it was before.
 * THE RUST TWIN STILL HAS ITS PIN (`ALLOWLIST_DIGESTS` in
 * rust/processing/tests/module_size_ratchet.rs), so the two gates deliberately
 * disagree for now: its table is 6 entries against the 38 this file used to pin, and its allowlist is
 * a fraction of the size, so it has not shown the contention #3745 measured on
 * this side. Retiring it is a separate, deferred change, not an oversight in
 * this one -- a reader landing in that header first should not conclude this
 * one is stale.
 *
 * WIRED INTO CI in the node-tests job of .github/workflows/test.yml, next to
 * the other source-shape gates. The initial allowlist grandfathers 312 files
 * and embodies a judgement about what counts as production TypeScript.
 *
 * The allowlist is a SNAPSHOT of the tree it was recorded from, so growth that
 * lands on main afterwards — from any PR, including ones this branch never
 * touched — makes the gate red on a long-lived branch. That is a DIFFERENT red
 * from the one your own change causes, and the two do not share a remedy:
 *
 *   Growth YOUR change caused — re-record it with
 *   `pnpm lint:module-size-baseline`, in the same commit that grows the file.
 *
 *   Growth INHERITED from main, after a merge — the scoped command cannot fix
 *   this one. That growth is by definition outside the files your change
 *   touched, so the run reports success and leaves the gate red. It takes
 *   `--update --all --allow-raise`: `--all` to reach outside your scope, and
 *   `--allow-raise` because re-recording a file that grew IS a raise and the
 *   command refuses one unless asked twice. Without it, `--update --all` writes
 *   nothing and exits 1 the moment any file grew -- on a shrink-only tree it
 *   succeeds, which is why "it always refuses" would be the wrong thing to
 *   remember. It re-records every stale row in the tree on the way
 *   past, which is why it is a maintainer sweep in its OWN commit and its own
 *   PR rather than something to bundle into yours.
 *
 *   Both spellings are pinned by tests, because this paragraph has now been
 *   wrong three separate ways — it named a command that silently did nothing,
 *   then one that pnpm could not even parse, then one that refuses to write.
 *   Prose describing a command is a claim about behaviour, and the only thing
 *   that keeps it true is a test that runs it.
 *
 * Neither is licence to raise a budget for growth the PR itself introduced,
 * which is why the regeneration command refuses a raise unless asked twice.
 *
 * What the step breaks on afterwards, by design: any PR adding a TS/TSX/MJS/
 * CJS file over 400 lines, or any PR growing a listed file past its recorded
 * budget. It does NOT break on a file shrinking or disappearing in a PR that
 * never touched the file or its row; those stay advisory notes.
 *
 * THE MERGE-BASE AUDIT (#4388) is the third thing check mode fails on: an
 * allowlist ROW that this change wrote and the measurement does not justify.
 * The two teeth judge files against rows; neither judged the row, so a
 * conflict resolution that resurrected a deleted row for a 268-line file,
 * kept the row of a file a split had taken to 348, and carried 766 for a
 * 765-line file printed three notes and OK (#4330). Check mode now diffs the
 * allowlist against `git merge-base origin/main HEAD` and holds every row
 * that differs -- added, raised or lowered -- to the count `--update` would
 * have written, and fails a row kept unchanged when this change's own diff
 * took the file under the limit or removed it. The Rust twin's allowlist is
 * audited by the same rules from here (the cargo test has no git). Rows this
 * change did not write and files it did not touch stay advisory, which is
 * the advisory rationale below preserved rather than dropped. No base (no
 * `origin/main`, no `main`, or --root not a worktree top) is a hard failure
 * under CI and a loud skip elsewhere; `--base <ref>` names a base by hand.
 *
 * WHAT THIS GATE CANNOT SEE: it counts lines, nothing else. A 400-line file
 * doing five jobs passes; a cohesive 900-line table fails. It does not look at
 * plain .js (four hand-written ones under scripts/ at last count — #3672 left
 * them out deliberately), at anything outside packages/, apps/ and scripts/
 * (tools/ holds ~26 more .mjs), at generated, declaration or test files, or at
 * whether a "split" merely moved lines into a sibling file. Freezing a size is
 * not the same as enforcing a design.
 *
 * .mjs/.cjs became part of the population in #3672: this script's own header
 * describes the "extension filter hides a whole tree" defect it was written to
 * close for TypeScript, and it then reported `OK (2084 files measured)` while
 * 208 non-test .mjs files — several over 1,000 lines, this tree's CI gates
 * among them — were invisible to it. Same shape as #3639/#3662
 * (check-source-text-assertions).
 *
 * Run: node scripts/check-module-size.mjs
 * Regenerate: pnpm lint:module-size-baseline   (node scripts/check-module-size.mjs --update)
 * Repo-wide sweep, its own PR: node scripts/check-module-size.mjs --update --all --allow-raise
 *
 * An absolute-budget ratchet fights a moving main by construction: any
 * long-lived branch accumulates a red made of files it never touched, and a
 * contributor reading a list of unfamiliar filenames reasonably concludes the
 * gate is noise. `--update` is the supported way to re-record the rows your
 * change touched, so that hand-editing the allowlist stops being the only one —
 * a hand-edited ratchet is one distracted afternoon from someone raising a
 * budget instead of splitting a file, which is the exact thing this gate exists
 * to prevent.
 *
 * `--update` refuses, by itself, to do the one thing that would make it a
 * loophole: it will not raise a budget or add a new exemption. Those need
 * `--allow-raise` on the command line, so the loosening is a deliberate act
 * that shows up in the shell history and in the allowlist's own row diff.
 * `check-unused-locals.mjs --update` has no such safeguard.
 *
 * `--update` NO LONGER MEASURES A FILE IT ALSO WRITES, which is what #3727 and
 * #3693 were about. The digest block lived in THIS file and was one line per
 * scope, so a sweep that added or removed a scope moved this file's length
 * after its own row had been written: the run recorded the pre-rewrite count,
 * reported success and exited 0, and the next plain run measured the real file
 * and failed. `lib/module-size-self-pin.mjs` existed to settle that loop to a
 * fixed point. Removing the pin (#3745, above) removes the loop instead: the
 * only file `--update` writes is the allowlist, a `.txt` that `SOURCE_RE` never
 * matches, so the measurement the run starts from IS the tree it leaves behind
 * and the settle step had nothing left to settle. The self-pin module went with
 * it. If anything here ever becomes self-rewriting again, that fixed point has
 * to come back with it -- `git log scripts/lib/module-size-self-pin.mjs` is
 * where it is.
 *
 * `--update` IS SCOPED to the files your change touched (#3398), derived from
 * `git diff` against the merge base with main plus anything untracked. It used
 * to re-record every row in the tree, which sounds harmless — it only ever
 * TIGHTENED rows it was not asked about — and is not: `slack` and `shrunk` are
 * advisory precisely so a shrink landing on main cannot redden an open PR, so
 * headroom accumulates on main and the next `--update` annexes all of it.
 * Measured on an unmodified checkout of afa717bcf: 11 rows rewritten with a
 * clean `git status`. Two PRs that regenerate in the same window then carry
 * the identical hunks and conflict over changes neither of them made, which
 * is the collision #3398 was filed for. `--all` is the deliberate repo-wide
 * regenerate, and it belongs in its own PR.
 *
 * Flags (development and the test harness only; CI would pass none):
 *   --root <dir>       scan this tree instead of the repo
 *   --allowlist <path> read this allowlist instead of the committed one
 *   --update           re-record the rows your change touched
 *   --allow-raise      with --update, permit budget raises and new exemptions
 *   --all              with --update, re-record EVERY row in the tree, not
 *                      only the changed ones (and skip the git derivation)
 *   --base <ref>       merge base against this ref instead of origin/main
 *                      (then main); for odd clones and the test harness
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIMIT,
  countLines,
  isExempt,
  parseAllowlist,
  evaluate,
  staleRows,
  planUpdate,
  renderAllowlist,
} from './lib/module-size-ratchet.mjs';
import { changedFilesWarned, describeBase } from './lib/module-size-git.mjs';
import { compactAudit } from './lib/module-size-base-audit.mjs';
import { runMergeBaseAudits } from './lib/module-size-audit-run.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, '..');

/**
 * Trees walked. `apps/server` is a Rust crate and contributes no TS files.
 * `scripts` is almost entirely .mjs and is where the CI gates themselves live,
 * which is why it joined the walk in #3672.
 */
const SEARCH_DIRS = ['packages', 'apps', 'scripts'];

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

const SOURCE_RE = /\.(ts|tsx|mts|cts|mjs|cjs)$/;

function parseArgs(argv) {
  const out = {
    root: REPO_ROOT,
    allowlist: null,
    update: false,
    allowRaise: false,
    all: false,
    base: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--root' || flag === '--allowlist' || flag === '--base') {
      if (value === undefined) fail(`${flag} needs a value`);
      out[flag.slice(2)] = value;
      i += 1;
    } else if (flag === '--update') {
      out.update = true;
    } else if (flag === '--allow-raise') {
      out.allowRaise = true;
    } else if (flag === '--all') {
      out.all = true;
    } else if (flag === '--') {
      // npm, yarn and pnpm each treat the conventional `--` separator
      // differently, and pnpm forwards it to the script verbatim. Refusing it
      // makes `pnpm lint:module-size-baseline -- --all` -- the spelling a
      // contributor types out of habit -- die before writing anything, which
      // is the same defect this file's own docstring is about: documented
      // advice that does not work. Tolerate it and read the rest.
      continue;
    } else {
      fail(`unknown argument: ${flag}`);
    }
  }
  // `--allow-raise` alone reads as "budgets may go up" and does nothing, which
  // is the worst way for a safety flag to behave. Refuse it instead, and refuse
  // a bare `--all` for the same reason: it reads as "check everything".
  if (out.allowRaise && !out.update) fail('--allow-raise only means something with --update');
  if (out.all && !out.update) fail('--all only means something with --update');
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
    `no TypeScript or Node-script files matched under ${SEARCH_DIRS.join(', ')} in ${args.root}. ` +
      'Exiting 0 here would certify a tree nobody looked at.',
  );
}

if (args.update) {
  // Scoped by default; `--all` is the deliberate act, so the annexation can
  // only happen when someone asked for it and said so in a PR.
  let changed = null;
  let scopeNote =
    'check-module-size: --all: re-recording EVERY row in the tree, ' +
    'including rows this change never touched.';
  if (!args.all) {
    const derived = changedFilesWarned(args.root, args.base);
    if (derived.error !== undefined) {
      fail(
        `--update re-records only the files your change touched, and deriving those needs git.\n\n` +
          `  ${derived.error}\n\n` +
          `Run it at the top of a worktree with an \`origin/main\` or \`main\` base, or pass\n` +
          `--all for a deliberate repo-wide regenerate — which also re-records every stale\n` +
          `row in the tree, so it belongs in its own PR rather than bundled into yours.\n\n` +
          `Nothing was written.`,
      );
    }
    changed = derived.changed;
    // Report the population scoping can ACT on, not every changed path. A PR
    // touching a lockfile, some docs and one module was printing "scoped to 200
    // changed file(s)" next to "0 lowered, 0 removed", which reads as the
    // scoping having silently done nothing.
    const actionable = [...changed].filter(
      (rel) => SOURCE_RE.test(rel) && !isExempt(rel) && SEARCH_DIRS.some((d) => rel.startsWith(`${d}/`)),
    ).length;
    scopeNote =
      `check-module-size: scoped to ${actionable} changed module(s) ` +
      `(of ${changed.size} changed path(s)) vs ${describeBase(derived.base)}; ` +
      `pass --all to re-record every row.`;
  }
  console.log(scopeNote);

  const { next, raised, added, lowered, removed } = planUpdate(files, allowlist, changed);

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
        `justified, say why in the PR and re-run with --allow-raise; the row itself\n` +
        `is the reviewable line.\n\n` +
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

  for (const row of lowered) console.log(`lowered:${row}`);
  for (const row of removed) console.log(`removed:${row}`);
  for (const row of raised) console.log(`RAISED:${row}`);
  for (const row of added) console.log(`ADDED:${row}`);
  console.log(
    `check-module-size: wrote ${next.size} rows to ${args.allowlist} ` +
      `(${lowered.length} lowered, ${removed.length} removed, ${raised.length} raised, ${added.length} added).`,
  );

  // Re-evaluate against what was actually WRITTEN, and exit on the answer.
  // A scoped regenerate leaves inherited growth untouched by design, so it used
  // to print "Commit both." and exit 0 while the gate stayed red -- reporting
  // success for a run that fixed nothing the contributor was failing on. The
  // docstring admitted this in prose and the code did not act on it, which is
  // the same shape as the header claim this whole issue is about.
  //
  // `files` is still the right measurement to check against: the one write above
  // is the allowlist, whose `.txt` path `SOURCE_RE` never matches, so nothing in
  // the measured population moved and a second walk would re-derive the same
  // answer. That was NOT true while this file carried the digest pin, which is
  // how the check could confirm a baseline the same run had broken (#3727).
  const after = evaluate(files, next);
  if (after.newOffenders.length > 0 || after.grew.length > 0) {
    console.error(`
check-module-size: the allowlist was rewritten, but the gate is STILL RED for
files outside this change's scope:\n
${[...after.newOffenders, ...after.grew].join('\n')}

That growth came from main, not from your change, so a scoped regenerate cannot
reach it. Clear it with a maintainer sweep in its OWN commit and its own PR:

  pnpm lint:module-size-baseline --all --allow-raise
`);
    process.exit(1);
  }
  process.exit(0);
}

let failed = false;

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
New source file(s) over ${LIMIT} lines with no allowlist row:\n
${newOffenders.join('\n')}

Split them (AGENTS.md house rule), or — only with a written justification in
the PR — add a row to scripts/module-size-allowlist.txt.
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

// Advisory when the shrink is somebody else's: a shrink landing in another
// PR cannot turn this one red. Mirrors the Rust gate's advisory notes. When
// the shrink is THIS change's, the merge-base audit below fails it (#4388).
for (const row of shrunk) {
  console.log(`note: ${row.trim()} <= ${LIMIT}; delete its allowlist row (the total must trend down)`);
}
for (const row of missing) {
  console.log(`note:${row} no longer matches a tracked file (gone, renamed or now exempt); remove it`);
}
// Advisory: headroom a file can grow into with nothing firing. Not a failure,
// because a shrink landing in another PR would otherwise turn this one red —
// but it must be VISIBLE, or the ratchet quietly stops being one for that row.
// A row THIS change wrote with headroom in it is a different thing, and the
// audit below fails that one.
for (const row of slack) {
  console.log(`note:${row}; lower the budget to the measured count`);
}

// The merge-base audit (#4388): rows that differ from the base were written by
// this change, and each must say what the file says. Rules in
// lib/module-size-base-audit.mjs, the run in lib/module-size-audit-run.mjs.
const { failed: auditFailed, tsAudit, scope } = runMergeBaseAudits({
  root: args.root,
  allowlistPath: args.allowlist,
  headRows: allowlist,
  measured: new Map(files.map((f) => [f.rel, f.lines])),
  baseRef: args.base,
});
if (auditFailed) failed = true;

if (failed) process.exit(1);

const auditNote =
  tsAudit === null ? 'merge-base audit SKIPPED' : `vs merge-base ${scope.base.sha.slice(0, 9)}: ${compactAudit(tsAudit)}`;
console.log(
  `check-module-size: OK (${files.length} files measured, ${allowlist.size} allowlisted, 0 new over ${LIMIT}; ${auditNote})`,
);
