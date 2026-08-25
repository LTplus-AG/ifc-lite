#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Does THIS commit carry a version bump?" — the gate that decides whether
 * the publish verifiers run, in `.github/workflows/release.yml`.
 *
 * WHY NOT THE ROOT VERSION. The obvious spelling compares the ROOT
 * `package.json` version against `HEAD~1`, and it is wrong here.
 * `scripts/sync-versions.js` sets the root version to the HIGHEST workspace
 * version and deliberately does NOT lockstep the workspace — changesets owns
 * each package's version independently. Measured on this repo at the time of
 * writing: 47 workspace packages across 38 distinct versions, with exactly
 * ONE package sitting at the root version. So the root version moves only
 * when that one package is bumped.
 *
 * Replaying the root-only comparison across the last 60 `chore: version
 * packages` commits on `main` opened the gate on 16 of them. The other 44 are
 * real publishes (1–36 workspace `package.json` files bumped each), and on
 * those the gate collapses to `published == 'true'` — i.e. back to the bug
 * #3181 is about: the re-run that RECOVERS a partial publish publishes
 * nothing, so it reads `published == false`, so verification is skipped on
 * precisely the attempt that needed it.
 *
 * Comparing EVERY workspace `package.json` against `HEAD~1` opens the gate on
 * 60/60 of those release commits and on 0/40 recent ordinary pushes.
 *
 * Deliberately NOT used as the signal:
 *   - `.changeset/*.md` deletions. Measured identically (60/60 and 0/40) on
 *     the same corpus, but it infers a publish from bookkeeping: it answers
 *     "were changesets consumed", which a manual `changeset version` run, a
 *     rebase, or a hand-deleted changeset also satisfies, and it goes blind
 *     the day a version is bumped without one.
 *   - The `Cargo.toml` workspace version. It tracks the ROOT version, so it
 *     inherits exactly the defect above, and it would answer for the crates
 *     lane only.
 *
 * A package REMOVED since `HEAD~1` is not a bump: this walks the packages
 * present in the checked-out tree, which is also what both verifiers derive
 * their expectations from.
 *
 * Executable proof: `scripts/release-version-changed.test.mjs`, which drives
 * real throwaway git repositories rather than stubbing git out.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isMainEntry } from './lib/is-main-entry.mjs';

/**
 * Workspace roots, matching `sync-versions.js`, which walks exactly these two.
 *
 * NOT the same list as `pnpm-workspace.yaml`, which carries a third root,
 * `examples/*`. That omission is deliberate and correct: all four example
 * packages are `private: true` and publish nothing, so a bump there is not a
 * release and must not fire the verifiers. Widen this only if an example ever
 * becomes publishable.
 *
 * The walk below is ONE level deep and skips symlinks, so a nested
 * (`packages/group/pkg/`) or symlinked package would be invisible to it —
 * while `sync-versions.js` uses `statSync`, which DOES follow symlinks. No
 * such package exists today (47 flat manifests under these two roots, none
 * nested, none a symlink), so the two agree; adding one would silently
 * separate them, and this walk is the side that goes quiet.
 */
export const WORKSPACE_PARENTS = ['packages', 'apps'];

/**
 * The `version` of a package manifest, or `null` when there is no text or no
 * `version` field.
 *
 * THROWS on text that is not JSON, deliberately. In the checked-out tree a
 * manifest that exists but does not parse is "cannot tell", not "no bump":
 * returning `null` here would drop that package from the walk, and a release
 * commit whose only bump was in the corrupt file would answer `false` and
 * skip verification. `versionAtRev` catches instead, because a manifest that
 * is unreadable at the PARENT rev already reads as a bump against the tree.
 */
function parseVersion(text) {
  if (text == null) return null;
  return JSON.parse(text).version ?? null;
}

function git(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Every versioned `package.json` in the checked-out tree — the root one plus
 * `packages/*` and `apps/*` — as repo-relative path -> version.
 */
export function currentVersions(repoRoot) {
  const versions = new Map();
  const rootVersion = parseVersion(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  if (rootVersion) versions.set('package.json', rootVersion);
  for (const parent of WORKSPACE_PARENTS) {
    let entries;
    try {
      entries = readdirSync(join(repoRoot, parent), { withFileTypes: true });
    } catch {
      continue; // a workspace root that does not exist in this checkout
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const rel = `${parent}/${entry.name}/package.json`;
      let text;
      try {
        text = readFileSync(join(repoRoot, rel), 'utf8');
      } catch {
        continue; // directory without a package.json
      }
      const version = parseVersion(text);
      if (version) versions.set(rel, version);
    }
  }
  return versions;
}

/**
 * The version of one `package.json` at `rev`, or `null` when the path did not
 * exist there (a brand-new package) or the file is unreadable.
 */
export function versionAtRev(repoRoot, rev, relPath) {
  try {
    return parseVersion(git(repoRoot, ['show', `${rev}:${relPath}`]));
  } catch {
    return null;
  }
}

/**
 * Does the checked-out tree bump any workspace version relative to
 * `previousRev`?
 *
 * Returns `{ changed, reason, bumps }` where `bumps` lists
 * `{ path, from, to }` for each moved version. `reason` is `'no-parent'` when
 * `previousRev` does not resolve (root commit, shallow clone): unknown must
 * read as CHANGED, because a false `false` skips verification on a real
 * release while a false `true` costs a handful of registry queries.
 *
 * THROWS rather than returning a verdict when the tree itself cannot be read
 * — no root `package.json`, a root or workspace manifest that is not JSON, no
 * `git` on PATH. There is no honest `{ changed }` for those, and swallowing
 * them here would put a `false` in front of a caller. Every caller must treat
 * a throw as "assume a bump"; `main()` below does exactly that, which is what
 * makes the CLI fail OPEN.
 */
export function versionChanged(repoRoot, { previousRev = 'HEAD~1' } = {}) {
  const current = currentVersions(repoRoot);
  let parentResolves = true;
  try {
    git(repoRoot, ['rev-parse', '--verify', '--quiet', `${previousRev}^{commit}`]);
  } catch {
    parentResolves = false;
  }
  if (!parentResolves) {
    return { changed: true, reason: 'no-parent', bumps: [] };
  }
  const bumps = [];
  for (const [path, to] of current) {
    const from = versionAtRev(repoRoot, previousRev, path);
    if (from !== to) bumps.push({ path, from, to });
  }
  return { changed: bumps.length > 0, reason: bumps.length > 0 ? 'bump' : 'none', bumps };
}

function main() {
  let result;
  try {
    result = versionChanged(process.cwd());
  } catch (err) {
    // Fail OPEN. Any unexpected failure here — no `git`, a missing root
    // `package.json`, a manifest that is not JSON — must not quietly answer
    // "no bump": that skips the publish verifiers on what may well be a
    // release commit. `.github/workflows/release.yml` closes the same hole on
    // its side, where a non-zero exit would kill the step before this line
    // could be reached at all.
    process.stderr.write(`version gate could not be evaluated (${err.message}) — assuming a bump\n`);
    process.stdout.write('true\n');
    return;
  }
  if (result.reason === 'no-parent') {
    process.stderr.write('no readable parent commit — assuming a version bump\n');
  } else if (result.changed) {
    process.stderr.write(
      `version bump on this commit (${result.bumps.length} package(s)):\n` +
        result.bumps.map((b) => `  ${b.path}: ${b.from ?? '<new>'} -> ${b.to}`).join('\n') +
        '\n'
    );
  } else {
    process.stderr.write('no version bump on this commit\n');
  }
  process.stdout.write(result.changed ? 'true\n' : 'false\n');
}

if (isMainEntry(import.meta.url)) main();
