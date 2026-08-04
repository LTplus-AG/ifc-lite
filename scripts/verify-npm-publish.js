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
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

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

function getWorkspacePackages() {
  const packages = [];
  for (const parent of ['packages', 'apps']) {
    const parentDir = join(rootDir, parent);
    try {
      for (const entry of readdirSync(parentDir)) {
        const pkgJsonPath = join(parentDir, entry, 'package.json');
        try {
          statSync(pkgJsonPath);
          packages.push(pkgJsonPath);
        } catch (error) {
          // A directory with no package.json is ordinary; anything else means
          // we may be skipping a package we were asked to verify.
          if (error.code !== 'ENOENT') {
            console.warn(`⚠️  Could not stat ${pkgJsonPath}, skipping it (${error.message})`);
          }
        }
      }
    } catch (error) {
      // Same: an absent `apps/` or `packages/` is ordinary, but an unreadable
      // one silently shrinks the set this release gate checks.
      if (error.code !== 'ENOENT') {
        console.warn(`⚠️  Could not list ${parentDir}, skipping it (${error.message})`);
      }
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

  if (toCheck.length === 0) {
    console.log('No publishable packages found.');
    process.exit(0);
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
