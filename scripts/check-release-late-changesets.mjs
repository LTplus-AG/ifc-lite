#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Is this a release commit that still carries a pending changeset?" (#5647)
 *
 * changesets/action publishes only when the checked-out tree has NO pending
 * `.changeset/*.md`. A `chore: version packages` commit that still carries one
 * takes the version-PR path instead: the Release run goes green and nothing is
 * published. That happens whenever a PR with a changeset lands after the
 * Version Packages PR was last refreshed, and on this repo's merge queue it is
 * routine: the refresh lags `main` by at least one Release run, and the queue
 * squashes the version PR's diff onto whatever landed ahead of it. Observed on
 * 9e5994c7f, which bumped 20 manifests with `cozy-seals-knock.md` (added two
 * minutes earlier by 77ace0aa6) still in its tree.
 *
 * The same hole opens without a stale PR: the merge queue lands up to five
 * entries in ONE push and Release runs once, on its tip, so a Version
 * Packages entry followed by an entry that adds a changeset publishes nothing
 * either. Hence `--base`: the comparison spans everything one push can carry.
 *
 * Three callers, one verdict:
 *
 *   - `.github/workflows/test.yml`, `changes` job (feeds the required
 *     `Build + WASM + Rust + Node` context). On `merge_group` the tentative
 *     commit is checked against the current `main` tip, so a stale Version
 *     Packages PR, or a changeset entry queued behind a Version Packages
 *     entry, is kicked from the queue instead of landing. `--context merge`
 *     (`push` on a push to main, where it can only report).
 *   - `.github/workflows/release-pr-freshness.yml` (#5951). Merges normally
 *     bypass the queue, so on every push to `main` or `changeset-release/main`
 *     it squashes the open Version Packages PR onto the current `main` tip and
 *     runs this check (`--context merge`, `--base <main tip>`); a stale PR is
 *     converted to a draft, which not even an admin bypass can merge.
 *   - `.github/workflows/release.yml`, the backstop: a release commit that
 *     reaches `main` anyway turns its Release run red instead of silently
 *     opening a version PR. `--context release`.
 *
 * WHAT COUNTS AS A RELEASE COMMIT. `versionChanged` from
 * `release-version-changed.mjs` (the verifier gate, measured 60/60 on release
 * commits and 0/40 on ordinary pushes), narrowed to packages that EXISTED at
 * the parent. A brand-new workspace package is a bump there, deliberately, so
 * its first publish is verified. Here it would be a false positive: an
 * ordinary PR that adds a package ships a changeset for it, and "new package
 * plus pending changeset" is the normal shape of that PR, not a stale release.
 *
 * WHAT COUNTS AS PENDING. The file rule @changesets/read applies (its
 * `ignoredMdFiles`): a top-level `*.md` that is not a dotfile, not README (any
 * case), not AGENTS.md, CLAUDE.md or GEMINI.md. The same rule as the `pre`
 * step's `find` in release.yml. `.changeset/pre/` is not read; this repo does
 * not use pre mode.
 *
 * FAIL CLOSED. Exit 0 clean, 1 late changesets, 2 cannot tell (unreadable
 * base, a manifest that is not JSON, no git). "Cannot tell" is not "clean":
 * both workflows make the base revision available, so a 2 is a wiring
 * defect, and it must be as visible as the defect it would hide.
 *
 * Executable proof: `scripts/check-release-late-changesets.test.mjs`, against
 * real throwaway git repositories.
 */

import { appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { versionChanged } from './release-version-changed.mjs';

/** @changesets/read's `ignoredMdFiles`, verbatim. */
const IGNORED_MD = [/^README\.md$/i, 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];

/**
 * The pending changeset file names in `<repoRoot>/.changeset`, sorted. An
 * absent `.changeset` directory is zero pending; any other read error throws.
 */
export function pendingChangesets(repoRoot) {
  let entries;
  try {
    entries = readdirSync(join(repoRoot, '.changeset'), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter(
      (name) =>
        !name.startsWith('.') &&
        name.endsWith('.md') &&
        !IGNORED_MD.some((p) => (typeof p === 'string' ? p === name : p.test(name)))
    )
    .sort();
}

/**
 * The verdict for the checked-out tree against `previousRev`, which may be
 * any number of commits back (see `--base` below).
 *
 * Returns `{ verdict, bumps, pending }` where `verdict` is `'clean'`,
 * `'late-changesets'` or `'unknown'` (no readable parent). `bumps` are the
 * version moves of packages that existed at `previousRev`. THROWS when the
 * tree cannot be read (see `versionChanged`); the CLI maps that to exit 2.
 */
export function lateChangesets(repoRoot, { previousRev = 'HEAD~1' } = {}) {
  const result = versionChanged(repoRoot, { previousRev });
  const pending = pendingChangesets(repoRoot);
  if (result.reason === 'no-parent') return { verdict: 'unknown', bumps: [], pending };
  const bumps = result.bumps.filter((b) => b.from !== null);
  const verdict = bumps.length > 0 && pending.length > 0 ? 'late-changesets' : 'clean';
  return { verdict, bumps, pending };
}

const REMEDY = {
  merge:
    'Landing this queue entry would put a Version Packages commit and pending changesets into one push to main, ' +
    'which publishes nothing (changesets/action only publishes a tree with no pending changesets). ' +
    'If this is the Version Packages PR, it is stale: let the Release run for the latest main push refresh it, then queue it again. ' +
    'If this is an ordinary PR queued behind the Version Packages PR, queue it again once that PR has landed on main.',
  push:
    'This push put a Version Packages commit and pending changesets on main together, so its Release run publishes nothing. ' +
    'Wait for that Release run to refresh the Version Packages PR, then merge the refreshed PR on its own; ' +
    '`changeset publish` then ships every workspace version that is not on npm yet, including the ones bumped here.',
  release:
    'This release commit published NOTHING: changesets/action only publishes a tree with no pending changesets, ' +
    'so it took the version-PR path. Recover by merging the refreshed Version Packages PR on its own; ' +
    '`changeset publish` then ships every workspace version that is not on npm yet, including the ones bumped here.',
};

function list(items, max = 10) {
  const shown = items.slice(0, max).map((s) => `  ${s}`);
  if (items.length > max) shown.push(`  ... and ${items.length - max} more`);
  return shown.join('\n');
}

/** The value after `flag`, `undefined` when the flag is absent, `null` when it has no value. */
function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  return value === undefined || value.startsWith('--') ? null : value;
}

/** The verdict as an exit status: 0 clean, 1 late changesets, 2 cannot tell. */
function evaluate(context, base) {
  let result;
  try {
    result = lateChangesets(process.cwd(), { previousRev: base });
  } catch (err) {
    process.stderr.write(
      `::error title=Late-changeset gate::could not be evaluated (${err.message}). ` +
        'Fix the unreadable package manifest or .changeset directory and re-run; this gate does not pass on "cannot tell".\n'
    );
    return 2;
  }
  if (result.verdict === 'unknown') {
    process.stderr.write(
      `::error title=Late-changeset gate::the base revision ${base} is not readable, so this commit cannot be checked. ` +
        'The checkout must contain it (fetch it, or deepen the clone).\n'
    );
    return 2;
  }
  if (result.verdict === 'clean') {
    process.stdout.write(
      result.bumps.length > 0
        ? `release commit (${result.bumps.length} version bump(s)) with no pending changesets\n`
        : `no version bump since ${base} (${result.pending.length} pending changeset(s))\n`
    );
    return 0;
  }
  process.stderr.write(
    `::error title=Release commit still carries changesets (#5647)::${REMEDY[context]}\n` +
      `Since ${base}, ${result.bumps.length} workspace version(s) moved:\n` +
      `${list(result.bumps.map((b) => `${b.path}: ${b.from} -> ${b.to}`))}\n` +
      `and the tree still carries ${result.pending.length} pending changeset(s):\n` +
      `${list(result.pending.map((p) => `.changeset/${p}`))}\n`
  );
  return 1;
}

/**
 * `--context merge|push|release` picks the remedy text (default `merge`).
 *
 * `--base <rev>` is what the tree is compared against (default `HEAD~1`).
 * Pass the base of everything that will reach main in ONE push: the Release
 * run happens once per push, on its tip, so a Version Packages commit and a
 * changeset from a later commit of the same push publish nothing together.
 * The merge queue lands up to five entries in one push, so test.yml passes
 * the current `main` tip on `merge_group` and `github.event.before` on push;
 * release.yml passes `github.event.before`.
 *
 * `--record <file>` appends `status=<0|1|2>` to `<file>` and exits 0 instead
 * of exiting with the status. release.yml passes `$GITHUB_OUTPUT`: it must
 * read the verdict before changesets/action mutates the tree, but fail only
 * at the END of the job, after the version-PR refresh that is the recovery.
 * If this process never gets as far as writing, the status stays unset, and
 * release.yml fails on anything that is not `0`.
 */
function main(argv) {
  // `null` (flag given without a value) must survive to the usage check, so
  // default only `undefined` (flag absent); `??` would swallow both.
  const withDefault = (v, dflt) => (v === undefined ? dflt : v);
  const context = withDefault(flagValue(argv, '--context'), 'merge');
  const record = flagValue(argv, '--record');
  const base = withDefault(flagValue(argv, '--base'), 'HEAD~1');
  if (!(context in REMEDY) || record === null || base === null) {
    process.stderr.write(
      'usage: check-release-late-changesets.mjs [--context merge|push|release] [--base <rev>] [--record <file>]\n'
    );
    return 2;
  }
  const status = evaluate(context, base);
  if (record === undefined) return status;
  appendFileSync(record, `status=${status}\n`);
  return 0;
}

if (isMainEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2));
