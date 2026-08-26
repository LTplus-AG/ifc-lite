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
 *
 * ANTI-VACUITY (#3200, finding 7). This runs in release.yml AFTER publish, so
 * its exit code is the last thing standing between a half-published release
 * and users. It already refused to find no package.json at all; one level in,
 * it did not. Two ways it could report a release verified having checked less
 * than the workspace, both reproduced on a synthetic tree:
 *
 *   - every discovered manifest being private printed `No publishable
 *     packages found.` and exited 0;
 *   - a `packages/` that could not be LISTED (an ENOTDIR/EACCES rather than an
 *     ENOENT) printed a warning, verified whatever `apps/` held, and finished
 *     with `All packages are published. 🎉`.
 *
 * Both are closed below. A parent or a manifest path that does not EXIST stays
 * ordinary; one that cannot be READ is fatal, because those two call for
 * different fixes and only the second means the set silently shrank. Past
 * discovery, PUBLISHABLE_FLOOR keeps the count honest against the real
 * workspace, where no realistic release drops it by a third.
 */

import { execSync } from 'child_process';
import { readFileSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Derived from this file's own location, with no argv override: the regression
// harness (verify-npm-publish.test.mjs) copies this one file into a synthetic
// tree, so the floors below are driven over real input without this release-lane
// gate growing a scan-root flag anyone could point somewhere else (#3200).
const rootDir = join(__dirname, '..');

/**
 * Lower bound on how many publishable packages this gate must actually query.
 * Measured on a healthy tree: `packages/` holds 45 manifests of which 42 are
 * publishable, `apps/` holds 2 of which 0 are — every published package lives
 * under `packages/`, so the floor is really a floor on that tree surviving
 * discovery. Set to 25, a wide margin below 42: ordinary churn (a package
 * split, a few retired or made private) never forces an edit here, while every
 * way this script can go blind — a wrong root, a parent that will not list, a
 * manifest read that stops matching — collapses the count towards zero, not to
 * 24.
 *
 * Deliberately NOT a per-parent floor: `apps/` publishes nothing today, so
 * `apps: at least 1` would be a floor on a number that is legitimately zero.
 */
const PUBLISHABLE_FLOOR = 25;

/** Refuse, loudly, with the exit code release.yml reads as "nothing proved". */
function refuse(message) {
  console.error(`❌ ${message}`);
  process.exit(2);
}

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
  /** Non-directory entries under a workspace parent, reported rather than hidden. */
  const notDirectories = [];
  for (const parent of ['packages', 'apps']) {
    const parentDir = join(rootDir, parent);
    try {
      for (const entry of readdirSync(parentDir)) {
        const pkgJsonPath = join(parentDir, entry, 'package.json');
        try {
          statSync(pkgJsonPath);
          packages.push(pkgJsonPath);
        } catch (error) {
          // A directory with no package.json is ordinary, and so is a plain
          // file sitting under packages/ — joining 'package.json' onto it
          // yields ENOTDIR, which likewise means "not a package". Anything
          // else means this path exists in some form we could not classify,
          // and skipping it drops a package the release may have been
          // supposed to publish.
          if (error.code === 'ENOTDIR') {
            // ENOTDIR is information-theoretically ambiguous: it proves only
            // that `entry` is not a directory, so a stray .DS_Store and a
            // package directory clobbered into a file are indistinguishable
            // from here. Treating it as ordinary is right (the repo carries
            // packages/.DS_Store today), but treating it as SILENT is not --
            // the only backstop is PUBLISHABLE_FLOOR, and with 42 real
            // publishable packages against a floor of 25 up to 17 could vanish
            // this way and still report green. Narrowing a gate to kill a false
            // positive opens a miss; the miss just has to be visible.
            notDirectories.push(join(parentDir, entry));
          } else if (error.code !== 'ENOENT') {
            refuse(
              `could not stat ${pkgJsonPath} (${error.code || error.message}). ` +
                'Refusing to treat an unreadable manifest path as an absent one — ' +
                'that is how a package drops out of a release check unnoticed.',
            );
          }
        }
      }
    } catch (error) {
      // Same distinction one level up, and it matters more here: an absent
      // `apps/` or `packages/` is ordinary, but one that will not LIST shrinks
      // the set this release gate checks by a whole tree while every remaining
      // package still reports ✅. Warning about that and carrying on was the
      // #3200 finding.
      if (error.code !== 'ENOENT') {
        refuse(
          `could not list ${parentDir} (${error.code || error.message}). ` +
            'Refusing to verify a release against whatever else happened to be readable — ' +
            'an unreadable workspace parent is not an empty one.',
        );
      }
    }
  }
  if (notDirectories.length > 0) {
    // A note, not a refusal. Every entry here is legitimately not a package
    // most of the time, so failing would fire on a Finder artefact. But saying
    // nothing is how a clobbered package directory leaves no trace at all.
    console.log(
      `note: ${notDirectories.length} entr${notDirectories.length === 1 ? 'y' : 'ies'} under a ` +
        'workspace parent are not directories and hold no package (ordinary for stray files; ' +
        'a package directory replaced by a file would look identical here):',
    );
    for (const d of notDirectories) console.log(`  - ${d}`);
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
    refuse('No package.json found under packages/ or apps/ — nothing was verified.');
  }
  const toCheck = [];

  for (const pkgPath of packagePaths) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    if (pkg.private || !pkg.name || !pkg.version) continue;
    toCheck.push({ name: pkg.name, version: pkg.version });
  }

  // The second floor, and the one the #3200 audit found missing: discovery can
  // succeed and still hand this loop nothing, or almost nothing, to verify.
  // Exiting 0 there reports a release as verified on the strength of zero
  // queries to the registry.
  if (toCheck.length < PUBLISHABLE_FLOOR) {
    refuse(
      `only ${toCheck.length} publishable package(s) found among ${packagePaths.length} ` +
        `manifest(s) under packages/ and apps/, expected at least ${PUBLISHABLE_FLOOR}. ` +
        'Refusing a vacuous pass: this gate runs after publish, and a run that queried ' +
        'npm about almost nothing has proved almost nothing about the release. If the ' +
        'workspace genuinely shrank this far, lower PUBLISHABLE_FLOOR in this file — ' +
        'deliberately, in a reviewable diff.',
    );
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
