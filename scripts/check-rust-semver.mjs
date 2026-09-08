#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Refuses a release whose Cargo version is too small for what the Rust
 * public API actually did.
 *
 * WHY (issue #3216). Nothing on the Rust side chooses the crate version.
 * `scripts/sync-versions.js` sets `[workspace.package] version` in
 * `Cargo.toml` to the HIGHEST npm workspace package version, and that number
 * comes from a changeset whose bump level was chosen for a TypeScript API. So
 * a change that is additive in TS and breaking in Rust ships to crates.io as a
 * minor or a patch, and a consumer pinned to `ifc-lite-processing = "6"`
 * breaks on `cargo update`. There was no `cargo-semver-checks` anywhere in
 * `.github/` or `scripts/`, so nothing compared the published crate's API
 * against the one about to replace it.
 *
 * WHAT THIS GATE IS. A CHECK, not an automation. It never picks a version and
 * never edits a manifest: it asks `cargo-semver-checks` what bump each crate's
 * API change requires, compares that with the bump the derived version
 * actually carries over the crate's latest release on crates.io, and FAILS
 * when the version is the smaller of the two. A release stopped before it
 * publishes is recoverable; a crate published under the wrong major is not.
 *
 * WHAT IT CATCHES: changes to the public API surface that
 * `cargo-semver-checks`' lint set recognises — a removed or renamed `pub`
 * item, a changed function signature or arity, a field added to a `pub` struct
 * that callers construct literally, a variant added to a
 * non-`#[non_exhaustive]` enum, a trait gaining a defaultless method, a `pub`
 * item losing a trait impl.
 *
 * WHAT IT DOES NOT CATCH, and no version-surface tool can:
 *   - a behaviour change under an unchanged signature (a unit, a rounding, a
 *     tolerance, an ordering). #3089 and #3160 were that shape.
 *   - anything reachable only with a non-default feature that
 *     cargo-semver-checks' feature heuristic leaves off.
 *   - the C ABI of `ifc-lite-ffi` as an ABI: the `extern "C"` functions are
 *     compared as Rust items, so a signature change is seen, but a
 *     `#[repr(C)]` struct's meaning changing under a stable layout is not.
 *   - anything about the npm packages. `scripts/check-api-surface.mjs` owns
 *     that surface, and it does NOT transfer to Rust: it diffs built `.d.ts`
 *     exports against a snapshot committed in this repo, which can say "this
 *     export vanished since the last commit" but not "this is breaking against
 *     the version that is live on crates.io" — and the published version is
 *     the only baseline a semver claim is about.
 *
 * So a green result here means "the public API surface did not change more
 * than this version number admits". It does not mean the release is
 * compatible.
 *
 * VACUITY. Every way this gate could report success over nothing is an
 * explicit failure with a named reason (#3194/#3200): an empty crate list, a
 * crate list that shrank below CRATE_FLOOR, a crate with no release on
 * crates.io to compare against, a missing `cargo-semver-checks` binary, an
 * unreadable workspace version, and a run that produced no verdict line. None
 * of those is a skip.
 *
 * Run: `node scripts/check-rust-semver.mjs`  (`pnpm check:rust-semver`)
 * Self-test: `node --test scripts/check-rust-semver.test.mjs`
 */

import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRATES, readWorkspaceVersion } from './lib/crates-io.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The gate must cover EVERY crate the release publishes, so the list is the
 * one the release itself uses — `CRATES` from `scripts/lib/crates-io.mjs`,
 * which `release-crates.mjs` and `verify-crates-publish.js` already share
 * (#3181). A second copy here would go stale exactly when a crate is added,
 * which is the moment this gate is most needed.
 */

/**
 * Floor on the crate count. Importing the list rather than re-typing it rules
 * out one drift, not all of them: a filter, a conditional entry, or a partial
 * edit still yields a short list, and a gate that checked two crates prints
 * the same success line as one that checked all seven. If a crate is genuinely
 * dropped from the release, lower this in the same commit.
 */
export const CRATE_FLOOR = 7;

/**
 * The version this release would publish, or null.
 *
 * `readWorkspaceVersion` (shared with release-crates.mjs) THROWS when the key
 * is missing and otherwise returns whatever string is there, semver or not.
 * Both have to become "no usable version" here rather than a crash or a value
 * the comparison silently mishandles.
 */
export function readVersionOrNull(rootDir) {
  let version;
  try {
    version = readWorkspaceVersion(rootDir);
  } catch {
    return null;
  }
  return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

/** The bump `current` carries over `baseline`: major | minor | patch | none. */
export function bumpLevel(baseline, current) {
  const b = baseline.split('.').map(Number);
  const c = current.split('.').map(Number);
  if (c[0] !== b[0]) return 'major';
  if (c[1] !== b[1]) return 'minor';
  if (c[2] !== b[2]) return 'patch';
  return 'none';
}

/**
 * Is `current` strictly AHEAD of `baseline`?
 *
 * [[bumpLevel]] answers which component differs, never in which direction, so
 * a release carrying 6.0.2 against a crates.io baseline of 7.0.0 reads as a
 * `major` — the top rank, which no `required` verdict can exceed. Every
 * comparison for that crate would then pass without examining anything, and
 * the checked line would read `7.0.0 -> 6.0.2 (major; requires major)`.
 *
 * This is HARDENING, not a fixed live defect: the Cargo version is derived
 * from the highest npm package version by scripts/sync-versions.js, and
 * changesets never walk a version backwards, so no route that reaches it is
 * known. The gate refuses it anyway — a comparison whose direction is
 * unchecked is exactly the shape this file exists to refuse.
 */
export function isVersionAdvanced(baseline, current) {
  const b = baseline.split('.').map(Number);
  const c = current.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (c[i] !== b[i]) return c[i] > b[i];
  }
  return false;
}

const RANK = { none: 0, patch: 1, minor: 2, major: 3 };

/**
 * The verdict of one `cargo-semver-checks` run.
 *
 * The exit code alone is NOT the signal: it is non-zero both for "this needs a
 * major and you wrote a minor" and for "rustdoc failed to build". Reading the
 * second as the first reports a semver break nobody can fix; reading it as a
 * pass is the vacuous green this gate exists to refuse. So the summary line
 * must be present and recognised, and anything else is NO_VERDICT, which
 * fails.
 */
export function interpretRun({ status, output }) {
  if (/Summary\s+no semver update required/.test(output)) {
    return { required: 'patch', reason: null };
  }
  const requires = output.match(/Summary\s+semver requires new (major|minor) version/);
  if (requires) return { required: requires[1], reason: null };
  return {
    required: null,
    reason:
      `NO_VERDICT: cargo-semver-checks exited ${status} without a "Summary" line — ` +
      'it could not build or compare the crate, so nothing was checked',
  };
}

/**
 * @param {object} deps
 * @param {string[]|null} deps.crates      crate names, from release-crates.mjs
 * @param {string|null} deps.workspaceVersion  the version the release would publish
 * @param {(crate: string) => string|null} deps.latestPublished  crates.io latest, or null
 * @param {(crate: string, baseline: string) => {status: number, output: string}} deps.runSemverChecks
 * @returns {{ok: boolean, failures: string[], checked: string[]}}
 */
export function checkRustSemver({ crates, workspaceVersion, latestPublished, runSemverChecks }) {
  const failures = [];
  const checked = [];
  // Crates the release would NOT republish (their version is already live).
  // Counted separately so the success line can never say "N crates checked"
  // about crates whose API was never compared — see the report at the end.
  let skipped = 0;

  // The SHAPE is checked here, not only in readVersionOrNull: a version
  // that is a string but not a semver triple makes every `bumpLevel`
  // comparison NaN, which reads as "no change", which reads as "already
  // published, nothing to gate" — a vacuous pass over every crate at once.
  if (!workspaceVersion || !/^\d+\.\d+\.\d+$/.test(workspaceVersion)) {
    return {
      ok: false,
      failures: [
        `BAD_VERSION: ${JSON.stringify(workspaceVersion)} is not a semver ` +
          '[workspace.package] version, so there is no version to judge the API change against',
      ],
      checked,
    };
  }
  if (!crates || crates.length === 0) {
    return {
      ok: false,
      failures: [
        'NO_CRATES: the crate list is empty, so this gate would have checked nothing. ' +
          'The CRATES array in scripts/release-crates.mjs is what it reads; if that moved, follow it.',
      ],
      checked,
    };
  }
  if (crates.length < CRATE_FLOOR) {
    return {
      ok: false,
      failures: [
        `CRATE_FLOOR: found ${crates.length} crate(s), fewer than the floor of ${CRATE_FLOOR}. ` +
          'The scan is wrong, not the release — if a crate was genuinely dropped from the ' +
          'publish list, lower CRATE_FLOOR in the same commit.',
      ],
      checked,
    };
  }

  for (const crate of crates) {
    const baseline = latestPublished(crate);
    if (!baseline) {
      failures.push(
        `NO_BASELINE: ${crate} has no release on crates.io to compare against, so its semver ` +
          'bump cannot be judged. A crate published for the first time must be bootstrapped by ' +
          'hand (see release-crates.mjs); a crate that IS published and reads as absent here ' +
          'means the registry lookup failed, and a failed lookup must not read as compatible.'
      );
      continue;
    }

    // Every version comparison below is arithmetic on three integers, so a
    // baseline that is not a semver triple makes each one NaN — and a NaN
    // comparison reads as "no change", which reads as a pass.
    if (!/^\d+\.\d+\.\d+$/.test(baseline)) {
      failures.push(
        `BAD_BASELINE: ${crate}'s latest release on crates.io reads ` +
          `${JSON.stringify(baseline)}, which is not a semver triple, so there is no ` +
          'comparable baseline to judge this release against.'
      );
      continue;
    }

    const carried = bumpLevel(baseline, workspaceVersion);
    if (RANK[carried] === 0) {
      // Same version as the one already on crates.io: release-crates.mjs skips
      // publishing it, so there is no new version whose bump could be wrong.
      checked.push(`${crate} ${baseline} — already published at this version, not republished`);
      skipped += 1;
      continue;
    }

    // Direction, which `bumpLevel` cannot see. Checked BEFORE the expensive
    // run: there is nothing useful to compare a backwards version against.
    if (!isVersionAdvanced(baseline, workspaceVersion)) {
      failures.push(
        `VERSION_NOT_ADVANCED: ${crate} is on crates.io at ${baseline}, but this release ` +
          `carries ${workspaceVersion}, which is not ahead of it. \`bumpLevel\` reports which ` +
          'component differs, not in which direction, so a backwards version reads as the ' +
          'largest bump there is and no required verdict could ever exceed it — the crate ' +
          'would pass this gate without its API being judged at all.'
      );
      continue;
    }

    const { required, reason } = interpretRun(runSemverChecks(crate, baseline));
    if (reason) {
      failures.push(`${crate}: ${reason}`);
      continue;
    }
    checked.push(`${crate} ${baseline} -> ${workspaceVersion} (${carried}; requires ${required})`);
    if (RANK[required] > RANK[carried]) {
      failures.push(
        `${crate}: its public API change requires a ${required.toUpperCase()} bump, but this ` +
          `release carries ${baseline} -> ${workspaceVersion}, which is a ${carried}. ` +
          'The Cargo version is derived from the highest npm package version ' +
          '(scripts/sync-versions.js), so a changeset written about the TypeScript API cannot ' +
          'express this. Do not weaken this check: either the Rust change is reverted or made ' +
          'additive, or the crate version is raised by hand before publishing.'
      );
    }
  }

  if (checked.length === 0 && failures.length === 0) {
    return {
      ok: false,
      failures: ['NO_CRATES_CHECKED: every crate was passed over without a verdict'],
      checked,
    };
  }
  return { ok: failures.length === 0, failures, checked, compared: checked.length - skipped };
}

/* ---------- real-world wiring (the unit tests inject fakes instead) ---------- */

function realLatestPublished(crate) {
  const res = spawnSync(
    'curl',
    [
      '-sS',
      '-H',
      'User-Agent: ifc-lite-release (github.com/LTplus-AG/ifc-lite)',
      `https://crates.io/api/v1/crates/${crate}`,
    ],
    { encoding: 'utf8' }
  );
  if (res.status !== 0) return null;
  try {
    const body = JSON.parse(res.stdout);
    return body?.crate?.max_stable_version || body?.crate?.max_version || null;
  } catch {
    return null;
  }
}

/**
 * `rust-toolchain.toml` pins this workspace to a dated nightly, and
 * cargo-semver-checks refuses it outright ("rustc version is not high enough:
 * >=1.93.0 needed, got 1.93.0-nightly"). Left alone that produces no Summary
 * line, so the gate would fail with NO_VERDICT on every crate — fail-closed,
 * but for the wrong reason and with no way to act on it. So the toolchain is
 * named explicitly, and overridable for the day stable moves under us.
 */
const SEMVER_TOOLCHAIN = process.env.IFC_LITE_SEMVER_TOOLCHAIN || 'stable';

function realRunSemverChecks(crate, baseline) {
  const res = spawnSync(
    'cargo',
    [
      `+${SEMVER_TOOLCHAIN}`,
      'semver-checks',
      '--package',
      crate,
      '--baseline-version',
      baseline,
      '--color',
      'never',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  return { status: res.status ?? -1, output: `${res.stdout || ''}${res.stderr || ''}` };
}

function main() {
  const probe = spawnSync('cargo', [`+${SEMVER_TOOLCHAIN}`, 'semver-checks', '--version'], {
    encoding: 'utf8',
  });
  if (probe.status !== 0) {
    console.error(
      `❌ TOOL_MISSING: \`cargo +${SEMVER_TOOLCHAIN} semver-checks\` is not available. This gate ` +
        'fails rather than skips: a release that could not be checked must not read as a ' +
        'release that passed. Install it with `cargo install cargo-semver-checks --locked` ' +
        `and make sure the \`${SEMVER_TOOLCHAIN}\` toolchain is present.`
    );
    process.exit(2);
  }

  const result = checkRustSemver({
    crates: CRATES,
    workspaceVersion: readVersionOrNull(REPO_ROOT),
    latestPublished: realLatestPublished,
    runSemverChecks: realRunSemverChecks,
  });

  for (const line of result.checked) console.log(`   ${line}`);
  if (!result.ok) {
    console.error('\n❌ Rust crate semver gate failed (#3216):\n');
    for (const f of result.failures) console.error(`  - ${f}\n`);
    process.exit(1);
  }
  if (result.compared === 0) {
    console.log(
      `✅ nothing to gate: all ${result.checked.length} crate(s) are already on crates.io at ` +
        `${readVersionOrNull(REPO_ROOT)}, so this release republishes none of them. ` +
        'No API was compared — do not read this as a compatibility result.'
    );
    return;
  }
  console.log(
    `✅ ${result.compared} of ${result.checked.length} crate(s) compared against crates.io; ` +
      `every Rust API change fits ${readVersionOrNull(REPO_ROOT)}`
  );
}

if (process.argv[1] && process.argv[1].endsWith('check-rust-semver.mjs')) main();
