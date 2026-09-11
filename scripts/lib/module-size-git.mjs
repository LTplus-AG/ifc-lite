/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Git plumbing for the TypeScript module-size ratchet
 * (`scripts/check-module-size.mjs`): the merge base with main, the paths a
 * change touched, and a blob at a commit. Split out of the CLI when #4388
 * gave check mode its own use for the merge base — the CLI is allowlisted
 * and may not grow, and `check-source-text-assertions.mjs` carries the same
 * derivation, so this is the copy the next gate should import rather than
 * write a third time.
 *
 * Every function here FAILS CLOSED: an unreadable path, a root that is not
 * the top of its worktree, or no merge base at all is an `{ error }`, never a
 * silent repo-wide fallback. A fallback is the annexation #3398 was about, in
 * the one context — a shallow clone, a detached checkout, a script — where
 * nobody is reading the output.
 */

import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function git(root, ...argv) {
  return spawnSync('git', ['-C', root, ...argv], { encoding: 'utf8' });
}

function safeRealpath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/**
 * The physical top of the worktree `root` is in, or `{ error }` when `root`
 * is not inside one or is not itself that top.
 *
 * Compare resolved paths: `git` answers with the physical path, while --root
 * may arrive through a symlink (macOS /var -> /private/var). Requiring the
 * top to BE the scanned root stops a synthetic tree nested inside some other
 * repository from silently inheriting that repository's diff. Either side
 * unresolvable is a REFUSAL, not a pass: `safeRealpath` answers null on
 * failure, so a bare `!==` would compare null to null and let the guard
 * through in exactly the case where it knows least about the two paths.
 */
export function worktreeTop(root) {
  const top = git(root, 'rev-parse', '--show-toplevel');
  if (top.status !== 0) return { error: `${root} is not inside a git worktree` };
  const toplevel = top.stdout.trim();
  const resolvedTop = safeRealpath(toplevel);
  const resolvedRoot = safeRealpath(root);
  if (resolvedTop === null || resolvedRoot === null || resolvedTop !== resolvedRoot) {
    return { error: `${root} is not the top of its git worktree (that is ${toplevel})` };
  }
  return { top: resolvedTop };
}

/**
 * This worktree's merge base with main: `{ ref, sha, fellBack }` or
 * `{ error }`. Tries `origin/main` then a local `main`, or ONLY `ref` when
 * one is given (`--base`), so a clone that names its upstream differently can
 * still say which ref it means.
 *
 * `main` can be arbitrarily far behind `origin/main` (measured: 147 commits,
 * widening `--update`'s scope from 0 files to 381, 49 of them allowlisted),
 * which is the annexation the scoping exists to prevent. The fallback is
 * still the right behaviour -- not every clone names its upstream `origin`
 * -- but it must not be a routine log line, so the caller is told it
 * happened and warns.
 */
export function resolveBase(root, { ref = null } = {}) {
  const candidates = ref === null ? ['origin/main', 'main'] : [ref];
  for (const candidate of candidates) {
    const merged = git(root, 'merge-base', candidate, 'HEAD');
    const sha = merged.stdout.trim();
    if (merged.status === 0 && sha !== '') {
      return { ref: candidate, sha, fellBack: ref === null && candidate !== 'origin/main' };
    }
  }
  return { error: `no merge base with ${candidates.join(' or ')}` };
}

/** `git show <sha>:<rel>` from `root`, or `null` if the blob is unreadable. */
export function readBlobAt(root, sha, rel) {
  const res = git(root, 'show', `${sha}:${rel}`);
  return res.status === 0 ? res.stdout : null;
}

/**
 * The paths this worktree changed relative to its merge base with main:
 * committed, staged, unstaged and untracked, all relative to the repo top.
 * `{ changed: Set, base: { ref, sha, fellBack }, top }` on success (`top` is
 * the physical worktree top, the directory the paths are relative to),
 * `{ error }` on failure.
 *
 * Git is the only honest discriminator between slack THIS change created and
 * slack inherited from main, which is why `--update` derives the scope
 * instead of taking a `--scope` flag: a flag nobody passes is the annexation
 * with extra steps. The same set is what check mode uses (#4388) to tell a
 * shrink this change made from one that landed elsewhere.
 */
export function changedFiles(root, { baseRef = null } = {}) {
  const top = worktreeTop(root);
  if (top.error !== undefined) return top;
  const base = resolveBase(root, { ref: baseRef });
  if (base.error !== undefined) return base;
  const nulSeparated = (res) => (res.status === 0 ? res.stdout.split('\0').filter(Boolean) : null);
  // `--no-renames` so a renamed module reports BOTH paths. Rename detection
  // reports only the destination, and the source's row is exactly the one that
  // has to be dropped.
  const diffed = nulSeparated(git(root, 'diff', '--name-only', '--no-renames', '-z', base.sha));
  // Untracked too: a god file written but not yet committed is the single most
  // likely thing a contributor is running this for.
  const untracked = nulSeparated(git(root, 'ls-files', '--others', '--exclude-standard', '-z'));
  if (diffed === null || untracked === null) return { error: 'git could not list the changed files' };
  return { changed: new Set([...diffed, ...untracked]), base, top: top.top };
}

/** `origin/main (abc123456)` — how the CLI names a base in its output. */
export function describeBase(base) {
  return `${base.ref} (${base.sha.slice(0, 9)})`;
}

/**
 * `changedFiles()` with the fallback warning both of the CLI's modes must
 * print the same way. A stale local `main` widens the scope, so the warning
 * is the only thing between a contributor and the annexation #3398 was
 * about -- and it must not be a routine log line.
 */
export function changedFilesWarned(root, baseRef, warn = console.warn) {
  const derived = changedFiles(root, { baseRef });
  if (derived.error === undefined && derived.base.fellBack) {
    warn(
      `check-module-size: WARNING -- no merge base with origin/main; fell back to ` +
        `local '${derived.base.ref}' (${derived.base.sha.slice(0, 9)}). If that ref is stale, the scope ` +
        `is WIDER than your change: a regenerate may annex rows you did not touch, and the ` +
        `merge-base audit may judge rows you did not write. Fetch origin/main and re-run.`,
    );
  }
  return derived;
}

/**
 * `CI` the way the Rust gates read it (`common::refuse_to_skip_in_ci`): set,
 * non-empty, and not a spelled-out "no".
 */
export function underCi(env = process.env) {
  const ci = env.CI;
  return ci !== undefined && ci !== '' && ci !== '0' && ci !== 'false';
}
