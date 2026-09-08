#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every changeset must name a package Changesets can actually release.
 *
 * Until this existed, a changeset naming something outside the workspace passed
 * every PR check — nothing on a PR read changesets — and failed the **Release**
 * workflow, which only runs on main. The breakage landed after review and
 * blocked every release until someone noticed:
 *
 *   Error: Found changeset lint-lane-unused-ratchet for package ifc-lite
 *   which is not in the workspace
 *
 * That was `"ifc-lite": patch` — the repo ROOT, which is private and not a
 * workspace member, so it looks like a package and is not one. The private
 * root is the easy mistake: a tooling-only change has no publishable package,
 * and naming the repo feels like the honest answer. The honest answer is no
 * changeset at all.
 *
 * `pnpm lint` runs this, so the mistake now fails on the PR that makes it.
 * Release stays the backstop; it simply should not be the first to know.
 */

import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import parseChangeset from '@changesets/parse';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const changesetDir = join(repoRoot, '.changeset');

/**
 * Names Changesets will accept: every workspace MEMBER, private ones included.
 *
 * Not "every published package" — `@ifc-lite/viewer` is `apps/viewer`, which is
 * private, and three pending changesets name it perfectly legitimately:
 * Changesets versions private members and simply does not publish them. The one
 * name that fails is the repo root, because the root is not a member at all.
 */
function workspaceNames() {
  const out = execFileSync(
    'pnpm',
    ['-r', 'exec', 'node', '-e', 'console.log(process.cwd())'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const names = new Set();
  // `process.cwd()` reports the realpath while `repoRoot` comes from this
  // file's own path, so a symlinked checkout makes a string compare miss — and
  // missing here would admit the repo root, the one name this exists to reject.
  const rootReal = realpathSync(repoRoot);
  for (const dir of new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))) {
    const manifest = join(dir, 'package.json');
    if (dir === rootReal || dir === repoRoot || !existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (pkg.name) names.add(pkg.name);
  }
  return names;
}

/**
 * The package names in one changeset, read with the parser Changesets itself
 * uses.
 *
 * Not a regex over the frontmatter. The first version of this matched
 * `"name": patch` with the quotes required, and `ifc-lite: patch` without them
 * is valid YAML that Changesets accepts and that regex silently returned
 * nothing for — so the guard would have passed the exact breakage it exists to
 * stop, in the one spelling a person is most likely to reach for (review, on
 * this PR). Parsing with `@changesets/parse` means this cannot disagree with
 * the thing it is predicting.
 */
function packagesIn(file) {
  try {
    // Reading is inside the try too: a directory named `x.md` throws EISDIR,
    // and a guard should say so rather than exit on a stack trace.
    return parseChangeset(readFileSync(join(changesetDir, file), 'utf8')).releases.map((r) => r.name);
  } catch (err) {
    return { error: err.message };
  }
}

const files = readdirSync(changesetDir)
  .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md');

if (files.length === 0) {
  console.log('changesets: none pending, nothing to check.');
  process.exit(0);
}

const known = workspaceNames();
const bad = [];
const unreadable = [];
for (const file of files) {
  const packages = packagesIn(file);
  if (!Array.isArray(packages)) {
    // Frontmatter Changesets cannot parse. Not "no packages named" — that is
    // the same mistake in a different coat.
    unreadable.push({ file, error: packages.error });
    continue;
  }
  // Zero packages is NOT an error: `pnpm changeset --empty` writes exactly
  // that, and Changesets consumes it without releasing anything. Rejecting it
  // would make this guard stricter than the workflow it predicts, which is its
  // own kind of wrong — the job is to agree with Release, not to have opinions
  // (review, on this PR).
  for (const name of packages) {
    if (!known.has(name)) bad.push({ file, name });
  }
}

if (unreadable.length > 0) {
  console.error('❌ These changesets could not be read as changesets:\n');
  for (const { file, error } of unreadable) console.error(`   .changeset/${file}: ${error}`);
  console.error('\nA changeset needs frontmatter Changesets can parse: `--- "@ifc-lite/pkg":');
  console.error('patch ---`, or the empty `--- ---` that `pnpm changeset --empty` writes.');
  process.exit(1);
}

if (bad.length > 0) {
  console.error('❌ These changesets name something that is not a workspace package.');
  console.error('   Left alone they would fail the Release workflow on main, after this');
  console.error('   PR merged, and block every release until removed:\n');
  for (const { file, name } of bad) console.error(`   .changeset/${file}: "${name}"`);
  console.error('\nName a workspace package. A change with no package behind it - CI,');
  console.error('scripts, workflows, tests - needs no changeset at all; naming the repo');
  console.error('root is not a way to give it one.');
  process.exit(1);
}

console.log(`changesets: ${files.length} pending, all naming workspace packages.`);
