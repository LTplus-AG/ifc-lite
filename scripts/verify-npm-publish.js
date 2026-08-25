#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Verifies that all non-private workspace packages are published on npm at
 * their expected version. Run this after a release to catch packages that
 * were accidentally skipped during publish.
 *
 * Usage:
 *   node scripts/verify-npm-publish.js
 *   node scripts/verify-npm-publish.js --retries 5 --delay 10000
 *
 * Options:
 *   --retries <n>   Number of retry attempts per package (default: 3).
 *                   Useful after a fresh publish where npm propagation takes
 *                   a few seconds.
 *   --delay <ms>    Milliseconds to wait between retries (default: 5000).
 */

import { execSync } from 'child_process';
import { readFileSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// `--root <dir>` points the package scan at an alternate tree, the same seam
// check-test-glob-coverage.mjs and check-server-bin-targets.mjs use. It exists
// so the regression harness can drive the FLOOR below over a synthetic tree —
// a floor nobody ever sees fire is the same shape of unexamined instrument this
// gate was fixed for (#3200). It does NOT affect which registry is queried.
const rootFlagIdx = process.argv.indexOf('--root');
if (rootFlagIdx !== -1 && !process.argv[rootFlagIdx + 1]) {
  console.error('--root requires a directory argument');
  process.exit(2);
}
const rootDir = rootFlagIdx === -1 ? join(__dirname, '..') : resolve(process.argv[rootFlagIdx + 1]);

// ── CLI option parsing ────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let retries = 3;
  let delay = 5000;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--retries' && args[i + 1]) retries = parseInt(args[++i], 10);
    if (args[i] === '--delay'   && args[i + 1]) delay   = parseInt(args[++i], 10);
  }
  return { retries, delay };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Query npm for the published version of `name@version`.
 *
 * Returns `{ ok, error }`. `npm view` exits non-zero both for the answer this
 * script is looking for ("that version is not published", E404) and for every
 * way the query itself can fail — no network, a 5xx from the registry, an
 * expired token, a proxy refusing CONNECT. Collapsing those to a bare `false`
 * made a registry outage read exactly like a missing publish, so the failure
 * text is carried out and printed with the ❌ line instead of discarded.
 */
function queryPublished(name, version) {
  try {
    const result = execSync(`npm view ${name}@${version} version`, { stdio: 'pipe' });
    return { ok: result.toString().trim() === version, error: null };
  } catch (error) {
    return { ok: false, error };
  }
}

/** First line of whatever npm complained about, for a one-line report. */
function npmReason(error) {
  if (!error) return null;
  const stderr = error.stderr ? error.stderr.toString().trim() : '';
  const text = stderr || error.message || String(error);
  return text.split('\n').find((l) => l.trim()) ?? null;
}

// This gate runs AFTER publish, so a path it cannot read is a release reporting
// itself verified with a package silently missing from the set (#3200). One
// helper for both call sites so the two messages cannot drift apart.
function refuseUnreadable(verb, path, error) {
  console.error(
    `❌ Could not ${verb} ${path} (${error.code || error.message}).\n` +
      '   Refusing to verify a release over a package set this gate could not read.',
  );
  process.exit(2);
}

function getWorkspacePackages() {
  const packages = [];
  for (const parent of ['packages', 'apps']) {
    const parentDir = join(rootDir, parent);
    try {
      // `withFileTypes`: a plain FILE under packages/ or apps/ -- a `.DS_Store`
      // on any macOS checkout -- makes `statSync(<file>/package.json)` throw
      // ENOTDIR, which the refusal below would report as "could not read",
      // aborting the release verification with a false diagnosis. Nothing was
      // unreadable; it simply is not a package directory (#3200 review).
      for (const dirent of readdirSync(parentDir, { withFileTypes: true })) {
        if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
        const pkgJsonPath = join(parentDir, dirent.name, 'package.json');
        try {
          statSync(pkgJsonPath);
          packages.push(pkgJsonPath);
        } catch (error) {
          // A directory with no package.json is ordinary. Anything else means we
          // may be skipping a package we were asked to verify, and this gate
          // runs AFTER publish — a warning here is a release reporting itself
          // verified with a package silently missing from the set (#3200).
          // ENOTDIR reaches here only via a symlink to a non-directory, which
          // is likewise "not a package", not "unreadable".
          if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
            refuseUnreadable('stat', pkgJsonPath, error);
          }
        }
      }
    } catch (error) {
      // Same: an absent `apps/` or `packages/` is ordinary (only one of the two
      // holds publishable packages today), but an unreadable one silently
      // shrinks the set this release gate checks (#3200).
      if (error.code !== 'ENOENT') refuseUnreadable('list', parentDir, error);
    }
  }
  return packages;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { retries, delay } = parseArgs();

  const packagePaths = getWorkspacePackages();
  // Distinct from "every package is private": finding no package.json at all
  // means the discovery step itself failed, and exiting 0 there would report a
  // release as verified having checked nothing.
  if (packagePaths.length === 0) {
    console.error('No package.json found under packages/ or apps/ — nothing was verified.');
    process.exit(2);
  }
  const toCheck = [];

  for (const pkgPath of packagePaths) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    if (pkg.private || !pkg.name || !pkg.version) continue;
    toCheck.push({ name: pkg.name, version: pkg.version });
  }

  // One level past the discovery floor above, and the one that actually bites
  // (#3200, finding 7): `packagePaths` can be healthy while every manifest reads
  // as private or version-less, which is what a half-written or half-read tree
  // looks like. Exiting 0 there prints "No publishable packages found" and the
  // release lane goes green having checked nothing.
  //
  // Measured on a healthy tree: 42 publishable packages, all under `packages/`
  // (`scripts/docs/check-package-readmes.mjs` carries a sibling floor over what
  // is today the same 42)
  // (`apps/` currently has none, which is why this is a floor on the TOTAL and
  // not per-parent). Set to 25 — enough headroom that retiring or privatising a
  // handful never forces an edit, while every way discovery goes blind
  // collapses the count toward 0 rather than to 24.
  const PUBLISHABLE_FLOOR = 25;
  if (toCheck.length < PUBLISHABLE_FLOOR) {
    console.error(
      `❌ Only ${toCheck.length} publishable package(s) found among ${packagePaths.length} ` +
        `manifest(s), expected at least ${PUBLISHABLE_FLOOR}.\n` +
        '   This gate runs after publish, so reporting a release as verified here would ' +
        'assert something it never checked.\n' +
        '   If packages were genuinely removed or privatised, lower PUBLISHABLE_FLOOR in the ' +
        'same commit.',
    );
    process.exit(2);
  }

  console.log(`\nVerifying ${toCheck.length} package(s) on npm (up to ${retries} retries each)…\n`);

  const failed = [];

  for (const { name, version } of toCheck) {
    let published = false;
    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      const res = queryPublished(name, version);
      published = res.ok;
      lastError = res.error;
      if (published) break;
      if (attempt < retries) {
        console.log(`  ⏳  ${name}@${version} not yet visible — waiting ${delay / 1000}s (attempt ${attempt}/${retries})…`);
        await sleep(delay);
      }
    }

    if (published) {
      console.log(`  ✅  ${name}@${version}`);
    } else {
      const reason = npmReason(lastError);
      console.log(`  ❌  ${name}@${version} — NOT found on npm${reason ? ` (npm said: ${reason})` : ''}`);
      failed.push({ name, version, reason });
    }
  }

  console.log();

  if (failed.length > 0) {
    console.error(`${failed.length} package(s) missing from npm after publish:\n`);
    for (const { name, version, reason } of failed) {
      console.error(`  • ${name}@${version}${reason ? ` — ${reason}` : ''}`);
    }
    console.error(
      '\nThis usually means the package was not included in the changeset or\n' +
      'the publish step failed silently.  Check the release logs and re-run\n' +
      '`pnpm publish -r --filter <package>` for the affected package(s).\n'
    );
    process.exit(1);
  }

  console.log('All packages are published. 🎉');
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
