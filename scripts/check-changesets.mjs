#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every changeset must name a package Changesets can actually release.
 *
 * A changeset for a name outside the workspace does not fail the PR - nothing
 * on a PR reads changesets. It fails the **Release** workflow, which only runs
 * on main, so the breakage lands after review and blocks every release until
 * someone notices:
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
 * So this checks the names on a PR, where the mistake is cheap to fix.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
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
  for (const dir of new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))) {
    const manifest = join(dir, 'package.json');
    if (dir === repoRoot || !existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (pkg.name) names.add(pkg.name);
  }
  return names;
}

/** The package names in one changeset's frontmatter. */
function packagesIn(file) {
  const raw = readFileSync(join(changesetDir, file), 'utf8');
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return [];
  return [...frontmatter[1].matchAll(/^\s*["']([^"']+)["']\s*:/gm)].map((m) => m[1]);
}

const files = readdirSync(changesetDir)
  .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md');

if (files.length === 0) {
  console.log('changesets: none pending, nothing to check.');
  process.exit(0);
}

const known = workspaceNames();
const bad = [];
for (const file of files) {
  for (const name of packagesIn(file)) {
    if (!known.has(name)) bad.push({ file, name });
  }
}

if (bad.length > 0) {
  console.error('❌ These changesets name something that is not a workspace package,');
  console.error('   which fails the Release workflow on main rather than here:\n');
  for (const { file, name } of bad) console.error(`   .changeset/${file}: "${name}"`);
  console.error('\nName a workspace package. A change with no package behind it - CI,');
  console.error('scripts, workflows, tests - needs no changeset at all; naming the repo');
  console.error('root is not a way to give it one.');
  process.exit(1);
}

console.log(`changesets: ${files.length} pending, all naming workspace packages.`);
