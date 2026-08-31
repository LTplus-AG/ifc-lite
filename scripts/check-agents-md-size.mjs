#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Size ratchet for AGENTS.md — the same instrument as
 * `scripts/check-module-size.mjs` and `rust/processing/tests/module_size_ratchet.rs`,
 * pointed at the file every AI contributor to this repo actually reads.
 *
 * WHY THIS EXISTS: AGENTS.md grew from 10,123 bytes to 48,066 bytes across 26
 * commits between eb2fd5af9 (2026-06-29) and a0250405f (2026-08-23) — 55 days,
 * ~690 bytes a day — and NOT ONE of those 26 commits made it smaller. Measured
 * by reading the blob size at every commit that touched it; the sequence is
 * strictly monotonic. AT `a0250405f` it was 6,899 words over 300 lines, with a
 * single line of 4,865 characters. Those figures are anchored to that SHA on
 * purpose: the commit that WIRES this gate also rewrites AGENTS.md to pass it,
 * so an unanchored "it is now" would be false by the time anyone read it.
 *
 * It grows because adding costs one commit and deleting costs an argument. An
 * instruction file nobody finishes is an instruction file that does not
 * instruct: past some length the marginal paragraph does not add a rule, it
 * hides the rules already there.
 *
 * THE ADMISSION RULE THIS GATE ENFORCES, in the maintainer's own words: IF A
 * LESSON CAN BE EXPRESSED AS A CI GATE, BUILD THE GATE AND WRITE NOTHING;
 * PROSE IS ONLY FOR WHAT NO GATE CAN EXPRESS. The ratchet is the ENFORCEMENT of
 * that rule, not the rule itself. It cannot read a paragraph and judge whether
 * a gate could have replaced it. What it can do is make the budget finite, so
 * that admitting a new paragraph costs deleting an old one, and the cheapest
 * way to pay is to convert the old one into a gate. That is the whole
 * mechanism: this file does not argue, it charges.
 *
 * The gate has two teeth:
 *  1. A recorded BYTE BUDGET per tracked AGENTS.md, which ratchets DOWN only. A
 *     file may shrink or stay flat, never grow. A NEW AGENTS.md with no row is
 *     held to DEFAULT_BUDGET and must then be recorded, so every tracked
 *     instruction file carries a budget and none floats free.
 *  2. NO LINE LONGER THAN MAX_LINE_CHARS characters. This is the tooth that
 *     matters. Line 18 at a0250405f is 4,865 characters (4,893 bytes) of
 *     unbroken prose, and buried inside it is the authoritative list of what
 *     this repo's CI actually enforces. A reader skimming for the enforcement
 *     map does not find it, because it is not a list, it is a wall. LONG LINES
 *     ARE HOW THIS FILE HIDES THINGS, and a byte budget alone does not catch
 *     them: the same content survives a shrink as one longer wall.
 *
 * WHY 2,000 CHARACTERS, calibrated against the population rather than picked:
 * at a0250405f exactly two lines in the six tracked AGENTS.md files exceed it —
 * line 18 (4,865) and line 135 (2,643) of the root file. The next longest line
 * anywhere in the six is 1,386. So 2,000 sits inside a 1,257-character gap: it
 * fires on the two walls of prose and on nothing else that exists today. A
 * limit tuned tighter would redden paragraphs nobody has complained about; one
 * tuned looser would leave line 135 in place.
 *
 * WHY A 6,000-BYTE DEFAULT for a new AGENTS.md: the five nested files run
 * 1,638 to 5,430 bytes (the largest is apps/viewer/AGENTS.md). 6,000 is above
 * every one of them, so the default is not a retroactive verdict on files that
 * already exist, and it is ~900 words — one pass, which is the property the
 * root file lost at 8x that size. A new package doc born bigger than every
 * existing package doc is the exact event worth stopping.
 *
 * DISCOVERY IS `git ls-files`, NOT A TREE WALK, and that is load-bearing. This
 * repo has 171 registered worktrees, many of them nested inside the primary
 * checkout, and a plain `find` for AGENTS.md there — already skipping
 * node_modules — returns 103 files against 6 tracked ones. A walk would measure
 * 97 stale copies of a file nobody edits, and every skip list written to fix that
 * (node_modules, .claude/worktrees, wtbase, whatever gets added next) is a list
 * that drifts. "What is in the repository" is the actual question, and git is
 * the only thing that answers it. When git cannot answer, the gate FAILS
 * CLOSED: a fallback walk would report success having measured the wrong tree,
 * which is the "absence read as success" shape this family of scripts exists to
 * avoid.
 *
 * A DISTINCT REMEDY PER FAILURE CLASS — they do not share one:
 *
 *   OVER BUDGET, growth YOUR change caused. Delete something. That is the
 *   point of the gate and there is no command for it. If what you added is a
 *   lesson a CI gate could express, build the gate and delete the paragraph you
 *   were about to keep; if it is not, find the paragraph that has since become
 *   a gate and delete that one instead. Re-recording is not the remedy here.
 *
 *   OVER BUDGET, growth INHERITED from main. This gate runs in CI on every PR,
 *   so main can never carry growth that was not recorded in the same commit.
 *   An inherited red therefore means your branch is carrying a STALE budget
 *   file, not that the ratchet needs loosening: take main's rows with
 *   `git checkout origin/main -- scripts/agents-md-budget.txt` for the files
 *   your change did not touch. Do NOT reach for `--update --allow-raise`; that
 *   would launder someone else's recorded growth into your PR's diff, where no
 *   reviewer is looking for it.
 *
 *   A NEW AGENTS.md with no row, at or under the default. Nothing is wrong —
 *   run `node scripts/check-agents-md-size.mjs --update` and commit the row.
 *   Recording a file the default already permitted is a TIGHTENING, so it needs
 *   no `--allow-raise`.
 *
 *   A NEW AGENTS.md over the default. Shrink it below 6,000 bytes. Recording it
 *   as-is is a new exemption and takes `--update --allow-raise` plus a written
 *   justification in the PR, exactly as a new module-size row does.
 *
 *   A LINE OVER THE LIMIT. Break the paragraph up. `--update` cannot help and
 *   does not pretend to: it re-records byte budgets, re-checks the lines, and
 *   still exits 1 while any line is over. A regenerate that printed success over
 *   a red gate is a defect check-module-size.mjs shipped and had to fix; this
 *   one is born with the re-check rather than acquiring it.
 *
 * WHERE THIS DELIBERATELY DIFFERS FROM check-module-size.mjs, since the two
 * will be read side by side:
 *  - NO DIGEST PIN. That pin exists because a 339-row allowlist can absorb a
 *    raise invisibly. This budget file has 6 rows; any edit to it IS a
 *    reviewable line of the PR diff, so a pin would add a second thing to keep
 *    in sync and buy nothing.
 *  - `--update` IS NOT SCOPED to the files your change touched. There, scoping
 *    stops a regenerate from annexing headroom that accumulated on main. Here
 *    there is no headroom to annex: NO WRITE CAN RAISE A ROW WITHOUT
 *    `--allow-raise`. (Writes come in three kinds, not two: lower a row to the
 *    file's measured size, remove a row for a file no longer tracked, or raise
 *    one, which needs the flag.) The worst an unscoped `--update` can do is
 *    tighten a row someone else shrank, which is the direction this gate wants.
 *  - EVERY tracked AGENTS.md keeps a row, including the small ones. The module
 *    ratchet deletes a row once the file drops under 400 lines, because there
 *    the row is an EXEMPTION from a universal limit. Here the row IS the limit,
 *    so deleting it would hand the file 6,000 bytes of fresh room to grow into.
 *
 * WHAT THIS GATE CANNOT SEE: it counts bytes and characters, nothing else. A
 * 6,000-byte file of pure noise passes; a tight 8,000-byte file fails. It
 * cannot tell a rule from an anecdote, cannot tell whether a deleted paragraph
 * was replaced by a gate or just deleted, and cannot stop the same prose from
 * being pushed into a nested AGENTS.md or a skill file instead. It measures the
 * budget, not the writing. A shrink that moves 3,000 bytes into
 * `apps/viewer/AGENTS.md` will show up here only as that file's own row
 * refusing to grow.
 *
 * Run:        node scripts/check-agents-md-size.mjs
 * Regenerate: node scripts/check-agents-md-size.mjs --update
 * A raise:    node scripts/check-agents-md-size.mjs --update --allow-raise   (justify it in the PR)
 *
 * Flags (development and the test harness only; CI passes none):
 *   --root <dir>      measure this worktree instead of the repo
 *   --budgets <path>  read/write this budget file instead of the committed one
 *   --update          re-record every row at its measured size
 *   --allow-raise     with --update, permit a raise or an over-default new row
 */

import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllowlist, renderAllowlist } from './lib/module-size-ratchet.mjs';
// The `<budget> <path>` format has ONE parser and ONE renderer, shared with
// check-module-size.mjs and the Rust ratchet. A third copy would mean a
// hardening applied to one of them reaching neither of the others.

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, '..');

/** Bytes a NEW AGENTS.md may have before it needs a row. See the docblock. */
const DEFAULT_BUDGET = 6000;

/** Characters, not bytes: a reader pays for glyphs, not for UTF-8 width. */
const MAX_LINE_CHARS = 2000;

/** Only these. `FOO-AGENTS.md` is not an instruction file. */
const AGENTS_MD_RE = /(^|\/)AGENTS\.md$/;

function fail(message) {
  console.error(`check-agents-md-size: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { root: REPO_ROOT, budgets: null, update: false, allowRaise: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--root' || flag === '--budgets') {
      if (value === undefined) fail(`${flag} needs a value`);
      out[flag.slice(2)] = value;
      i += 1;
    } else if (flag === '--update') {
      out.update = true;
    } else if (flag === '--allow-raise') {
      out.allowRaise = true;
    } else if (flag === '--') {
      // pnpm forwards the conventional `--` separator verbatim, so refusing it
      // would kill the exact spelling a contributor types out of habit. Same
      // tolerance check-module-size.mjs has, for the same reason.
      continue;
    } else {
      fail(`unknown argument: ${flag}`);
    }
  }
  // `--allow-raise` on its own reads as "budgets may go up" and would do
  // nothing, which is the worst way for a safety flag to behave.
  if (out.allowRaise && !out.update) fail('--allow-raise only means something with --update');
  if (out.budgets === null) out.budgets = join(out.root, 'scripts', 'agents-md-budget.txt');
  return out;
}

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Every TRACKED AGENTS.md under `root`, relative to it, sorted.
 *
 * `root` must BE the top of its worktree. Without that check a synthetic tree
 * nested inside another repository would silently inherit that repository's
 * index — which is precisely the failure mode the 171 nested worktrees here
 * make likely rather than theoretical.
 *
 * Throws on any git failure. There is no filesystem fallback: see the docblock.
 */
function trackedAgentsFiles(root) {
  const git = (...argv) => spawnSync('git', ['-C', root, ...argv], { encoding: 'utf8' });
  const top = git('rev-parse', '--show-toplevel');
  if (top.status !== 0) throw new Error(`${root} is not inside a git worktree`);
  const toplevel = top.stdout.trim();
  // Both sides resolved, and a null on either side is a REFUSAL rather than a
  // pass: comparing null to null with `!==` would let the guard through in the
  // one case where it knows least about the two paths.
  const resolvedTop = safeRealpath(toplevel);
  const resolvedRoot = safeRealpath(root);
  if (resolvedTop === null || resolvedRoot === null || resolvedTop !== resolvedRoot) {
    throw new Error(`${root} is not the top of its git worktree (that is ${toplevel})`);
  }
  const listed = git('ls-files', '-z', '--', '*AGENTS.md', 'AGENTS.md');
  if (listed.status !== 0) throw new Error(`git ls-files failed in ${root}: ${listed.stderr.trim()}`);
  // The pathspec is fnmatch and would also match `FOO-AGENTS.md`; the regex is
  // what makes the population exact.
  return listed.stdout.split('\0').filter((p) => p !== '' && AGENTS_MD_RE.test(p)).sort();
}

/** Characters per line, 1-indexed, for every line over `limit`. */
function longLines(text, limit = MAX_LINE_CHARS) {
  const over = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].length > limit) over.push({ line: i + 1, chars: lines[i].length });
  }
  return over;
}

const args = parseArgs(process.argv.slice(2));

let files;
try {
  files = trackedAgentsFiles(args.root);
} catch (err) {
  fail(
    `cannot list tracked AGENTS.md files.\n\n  ${err.message}\n\n` +
      `This gate reads the git index on purpose: a filesystem walk of this repo finds an\n` +
      `order of magnitude more AGENTS.md files than are tracked, the rest being nested\n` +
      `worktrees. There is no fallback walk, because measuring the wrong tree and exiting\n` +
      `0 is worse than failing here.`,
  );
}

if (files.length === 0) {
  fail(
    `no tracked AGENTS.md found under ${args.root}. Exiting 0 here would certify an ` +
      'instruction file nobody looked at.',
  );
}

const measured = files.map((rel) => {
  const full = join(args.root, rel);
  let buf;
  try {
    buf = readFileSync(full);
  } catch (err) {
    fail(
      `${rel} is tracked by git but unreadable (${err.message}). Restore it, or stage the ` +
        'deletion so it leaves the index.',
    );
  }
  return { rel, bytes: buf.length, text: buf.toString('utf8') };
});

let budgetsText;
try {
  budgetsText = readFileSync(args.budgets, 'utf8');
} catch (err) {
  fail(`cannot read ${args.budgets}: ${err.message}`);
}

let budgets;
try {
  budgets = parseAllowlist(budgetsText, args.budgets);
} catch (err) {
  fail(err.message);
}

/** Lines over the limit, in every measured file. Both modes report these. */
function lineOffenders() {
  const rows = [];
  for (const { rel, text } of measured) {
    for (const { line, chars } of longLines(text)) {
      rows.push(`  ${rel}:${line}: ${chars} characters (limit ${MAX_LINE_CHARS})`);
    }
  }
  return rows;
}

const LONG_LINE_REMEDY =
  `Break them into paragraphs, or into a list if that is what they really are.\n` +
  `A ${MAX_LINE_CHARS}+ character line is where this file hides its rules: the CI-gate list\n` +
  `sat inside one for weeks and skimming readers never reached it. There is no\n` +
  `budget row and no flag for this one — the only fix is to break the line up.`;

if (args.update) {
  const next = new Map();
  const raised = [];
  const added = [];
  const lowered = [];
  for (const { rel, bytes } of measured) {
    const budget = budgets.get(rel);
    // CLAMPED TO 1. parseAllowlist refuses `budget <= 0`, so recording the true
    // size of a tracked EMPTY AGENTS.md would write a row this gate's own parser
    // then rejects: `--update` exits 0 having written it, and every later run
    // dies with "bad budget in" and no way out but hand-editing. A gate must not
    // be able to write a file it cannot read. A 1-byte budget is still a ratchet
    // floor -- an empty file cannot grow without failing.
    next.set(rel, Math.max(1, bytes));
    if (budget === undefined) {
      // Recording a file the DEFAULT already permitted is a tightening, not a
      // new exemption; only an over-default row loosens anything.
      if (bytes > DEFAULT_BUDGET) {
        added.push(`  ${rel}: ${bytes} bytes (new row, over the ${DEFAULT_BUDGET}-byte default)`);
      } else {
        lowered.push(`  ${rel}: ${bytes} bytes (new row, was the ${DEFAULT_BUDGET}-byte default)`);
      }
    } else if (bytes > budget) {
      raised.push(`  ${rel}: ${bytes} bytes, budget ${budget} (+${bytes - budget})`);
    } else if (bytes < budget && Math.max(1, bytes) !== budget) {
      // Compared against the CLAMPED value, which is what actually gets written.
      // A tracked empty file measures 0 and is recorded as 1, so an unguarded
      // `bytes < budget` reported it as "lowered" on every run while the file
      // stayed byte-identical -- a message claiming a change that did not happen.
      lowered.push(`  ${rel}: ${bytes} bytes, budget ${budget} (-${budget - bytes})`);
    }
  }
  const removed = [...budgets.keys()]
    .filter((rel) => !next.has(rel))
    .map((rel) => `  ${rel} (budget ${budgets.get(rel)}) is no longer a tracked file`);

  const loosening = [...raised, ...added];
  if (loosening.length > 0 && !args.allowRaise) {
    fail(
      `refusing to loosen the ratchet.\n\n` +
        (raised.length > 0
          ? `AGENTS.md file(s) now PAST their recorded budget — recording the new size is a raise:\n\n${raised.join('\n')}\n\n`
          : '') +
        (added.length > 0
          ? `New AGENTS.md over the ${DEFAULT_BUDGET}-byte default — recording it is a new exemption:\n\n${added.join('\n')}\n\n`
          : '') +
        `Delete something instead. If the lesson you added can be expressed as a CI gate,\n` +
        `build the gate and write nothing; prose is only for what no gate can express.\n\n` +
        `If this growth came from main rather than from your change, do NOT re-record it:\n` +
        `take main's rows with \`git checkout origin/main -- scripts/agents-md-budget.txt\`.\n\n` +
        `If the growth is genuinely yours and genuinely justified, say why in the PR and\n` +
        `re-run with --allow-raise. It is one reviewable line either way.\n\n` +
        `Nothing was written.`,
    );
  }

  writeFileSync(args.budgets, renderAllowlist(budgetsText, next));
  for (const row of lowered) console.log(`lowered:${row}`);
  for (const row of removed) console.log(`removed:${row}`);
  for (const row of raised) console.log(`RAISED:${row}`);
  for (const row of added) console.log(`ADDED:${row}`);
  console.log(
    `check-agents-md-size: wrote ${next.size} rows to ${args.budgets} ` +
      `(${lowered.length} lowered, ${removed.length} removed, ${raised.length} raised, ${added.length} added).`,
  );

  // Re-check the OTHER tooth against what was written. `--update` cannot fix a
  // long line, so reporting success here would be a regenerate certifying a red
  // gate — the exact defect check-module-size.mjs grew its post-write
  // re-evaluation to stop.
  const stillLong = lineOffenders();
  if (stillLong.length > 0) {
    console.error(
      `\ncheck-agents-md-size: budgets were re-recorded, but the gate is STILL RED on line ` +
        `length:\n\n${stillLong.join('\n')}\n\n${LONG_LINE_REMEDY}\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

let failed = false;

const grew = [];
const newOverDefault = [];
const unrecorded = [];
const slack = [];
for (const { rel, bytes } of measured) {
  const budget = budgets.get(rel);
  if (budget === undefined) {
    if (bytes > DEFAULT_BUDGET) {
      newOverDefault.push(`  ${rel}: ${bytes} bytes (default ${DEFAULT_BUDGET}, +${bytes - DEFAULT_BUDGET})`);
    } else {
      unrecorded.push(`  ${rel}: ${bytes} bytes, no row`);
    }
  } else if (bytes > budget) {
    grew.push(`  ${rel}: ${bytes} bytes, budget ${budget} (+${bytes - budget})`);
  } else if (bytes < budget) {
    // Guarded by the clamp, as the --update branch is. A tracked EMPTY file
    // measures 0 and is recorded as the clamped 1, so an unguarded check printed
    // a permanent "1 bytes of headroom; re-record with --update" note whose
    // stated remedy is a no-op. Same defect, other branch.
    if (Math.max(1, bytes) !== budget) {
      slack.push(`  ${rel}: ${bytes} bytes, budget ${budget} (${budget - bytes} bytes of headroom)`);
    }
  }
}

const missing = [...budgets.keys()]
  .filter((rel) => !measured.some((m) => m.rel === rel))
  .map((rel) => `  ${rel} (budget ${budgets.get(rel)})`);

if (grew.length > 0) {
  failed = true;
  console.error(`
AGENTS.md file(s) grew PAST their recorded budget:\n
${grew.join('\n')}

Budgets ratchet DOWN. Delete something rather than raising one — and if what you
added is a lesson a CI gate could express, build the gate and write nothing;
prose is only for what no gate can express.

If this growth came from main and not from your change, your branch is carrying
a stale budget file: take main's rows with
  git checkout origin/main -- scripts/agents-md-budget.txt
for the files your change did not touch. Do not launder someone else's recorded
growth through --allow-raise.
`);
}

if (newOverDefault.length > 0) {
  failed = true;
  console.error(`
New AGENTS.md over the ${DEFAULT_BUDGET}-byte default, with no recorded budget:\n
${newOverDefault.join('\n')}

The default is above every nested AGENTS.md that already exists: a new
instruction file should not be born bigger than every instruction file that
already works. Shrink it under ${DEFAULT_BUDGET} bytes, then record it with
  node scripts/check-agents-md-size.mjs --update
Recording it at its current size is a new exemption: it needs --allow-raise and
a written justification in the PR.
`);
}

if (unrecorded.length > 0) {
  failed = true;
  console.error(`
Tracked AGENTS.md with no budget row:\n
${unrecorded.join('\n')}

Nothing is wrong with the file — it is under the ${DEFAULT_BUDGET}-byte default. Record it so
it ratchets from here:
  node scripts/check-agents-md-size.mjs --update
That is a TIGHTENING (the default already permitted this size), so it needs no
--allow-raise. Every tracked instruction file carries a budget; a file with no
row is one nothing is holding.
`);
}

const long = lineOffenders();
if (long.length > 0) {
  failed = true;
  console.error(`
Line(s) over ${MAX_LINE_CHARS} characters:\n
${long.join('\n')}

${LONG_LINE_REMEDY}
`);
}

// Advisory, never a failure: a shrink landing in someone else's PR must not
// redden this one. It still has to be VISIBLE, or the ratchet quietly stops
// being one for that row.
for (const row of slack) {
  console.log(`note:${row}; re-record with --update so the budget states the real size`);
}
for (const row of missing) {
  console.log(`note:${row} is no longer a tracked file; --update drops the row`);
}

if (failed) process.exit(1);

const total = measured.reduce((a, m) => a + m.bytes, 0);
console.log(
  `check-agents-md-size: OK (${measured.length} tracked AGENTS.md measured, ${total} bytes total, ` +
    `${budgets.size} budgeted, 0 over budget, 0 lines over ${MAX_LINE_CHARS} chars)`,
);
