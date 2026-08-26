#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one way this repo can express a Rust-only major (#3216, item 2).
 *
 * THE PROBLEM. The version every crate is published at is not chosen on the
 * Rust side at all: `scripts/sync-versions.js` takes the highest npm workspace
 * package version and writes it into `[workspace.package]`, and
 * `scripts/release-crates.mjs` publishes at whatever it reads back there. So a
 * change that is additive in TypeScript and breaking in Rust ships under the
 * TypeScript bump level. `scripts/check-rust-semver.mjs` (#3298) detects that
 * and refuses the publish — correctly — but refusing is only half an answer
 * while there is no way to then SAY "the crates need a major here".
 *
 * THE MECHANISM. `rust-major-offset.json` at the repo root holds one integer:
 * how many majors ahead of npm the crates run. The npm packages, the root
 * `package.json` and the `v*` release tag keep the version changesets chose;
 * the Rust manifests get `major + offset . minor . patch`. At offset 0 — where
 * this repo is today — the output is identical to what it has always been, so
 * adopting it changes no version anywhere.
 *
 * WHY AN OFFSET AND NOT AN OVERRIDE. An absolute override ("the crates are
 * 7.0.0") is right once and wrong forever after: the next npm patch does not
 * move it, `release-crates.mjs` sees the version already on crates.io and
 * skips, and Rust fixes stop reaching the registry until a human remembers to
 * edit the file again. An offset stays DERIVED — minors and patches keep
 * tracking npm with nobody in the loop — and is edited once per Rust-only
 * major, at the moment the semver gate has already stopped the release and a
 * human is looking at it.
 *
 * WHAT THIS DOES NOT DO. It does not decide whether the offset is big enough;
 * that is `check-rust-semver.mjs` reading the real API against crates.io. It
 * does not choose versions — it only shifts the major of one that changesets
 * chose. And it deliberately breaks the "one version across the monorepo"
 * property, which is the property #3216 says is a lie whenever Rust and
 * TypeScript disagree about what the change was.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const OFFSET_FILE_NAME = 'rust-major-offset.json';

/**
 * Floors. Each one is a count that CANNOT legitimately fall this low in this
 * repo, so reaching one means the scan looked somewhere wrong — and a scan
 * that examined nothing must never render as agreement. Measured on
 * `upstream/main` @ 4000cf5b7: 37 public workspace packages, 6 internal
 * dependency literals in the root `[workspace.dependencies]` table, 14 across
 * every manifest.
 */
export const MIN_WORKSPACE_PACKAGES = 20;
export const MIN_WORKSPACE_DEP_LITERALS = 6;
export const MIN_TOTAL_DEP_LITERALS = 10;

/** The crate directories whose manifests carry internal `version = "…"`
 * literals. Kept here, next to the pattern, so `sync-versions.js` (which
 * writes them) and `check-rust-major-offset.mjs` (which checks them) cannot
 * drift apart into "the writer skipped a file the checker never looked at". */
export const RUST_MEMBER_DIRS = ['core', 'geometry', 'processing', 'clash', 'export', 'ffi', 'wasm-bindings'];

/** A fresh `/g` regex each call — a shared one carries `lastIndex` between
 * callers and silently skips matches. */
export function internalDepPattern() {
  return /(ifc-lite-(?:core|geometry|processing|clash|export|wasm)\s*=\s*\{\s*version\s*=\s*")([^"]+)(")/g;
}

/** The `[workspace.package] version = "…"` literal. */
export const WORKSPACE_VERSION_PATTERN = /(\[workspace\.package\][^[]*version\s*=\s*")([^"]+)(")/;

/** An error carrying a machine-readable reason, so a caller can print WHY it
 * refused rather than a bare stack. */
export function offsetError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** A plain `major.minor.patch` and nothing else. Prereleases and build
 * metadata are rejected rather than approximated: this repo has never
 * published one, and guessing what `6.0.1-rc.1 + 1 major` means is exactly
 * the kind of silent approximation that put #3216 in the tree. */
export function parseSemver(version) {
  if (typeof version !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    throw offsetError('BAD_VERSION', `cannot compare versions ${JSON.stringify(a)} and ${JSON.stringify(b)}: not \`major.minor.patch\``);
  }
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

/** `6.1.0` + 1 major → `7.1.0`. Throws rather than producing `NaN.1.0`. */
export function applyMajorOffset(version, majorOffset) {
  const parsed = parseSemver(version);
  if (!parsed) {
    throw offsetError('BAD_VERSION', `${JSON.stringify(version)} is not a \`major.minor.patch\` version, so no major offset can be applied to it`);
  }
  if (!Number.isInteger(majorOffset) || majorOffset < 0) {
    throw offsetError('BAD_OFFSET', `major offset must be a non-negative integer, got ${JSON.stringify(majorOffset)}`);
  }
  return `${parsed.major + majorOffset}.${parsed.minor}.${parsed.patch}`;
}

/**
 * Read `rust-major-offset.json`. Absent, empty, unparseable, or carrying
 * anything but a non-negative integer are each a distinct named failure — the
 * file existing is what makes the crate version a decision rather than an
 * accident, so treating a missing one as "offset 0" would quietly restore the
 * behaviour this exists to replace.
 *
 * A NON-ZERO offset must additionally carry a `reason` and at least one
 * `refs` entry. An offset is a permanent major-version claim about published
 * crates; the one thing a reader will want six months later is what broke,
 * and prose that is required is prose that exists.
 */
export function readMajorOffset(rootDir) {
  const path = join(rootDir, OFFSET_FILE_NAME);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw offsetError(
      'NO_OFFSET_FILE',
      `${OFFSET_FILE_NAME} is missing (${error.message}). It is not optional: it is where the Rust crates' major offset over npm is declared, and without it there is no statement of what the crate version means. Restore it with {"majorOffset": 0} if the crates track npm exactly.`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw offsetError('BAD_JSON', `${OFFSET_FILE_NAME} is not valid JSON: ${error.message}`);
  }
  const majorOffset = parsed?.majorOffset;
  if (!Number.isInteger(majorOffset) || majorOffset < 0) {
    throw offsetError(
      'BAD_OFFSET',
      `${OFFSET_FILE_NAME} must set "majorOffset" to a non-negative integer, got ${JSON.stringify(majorOffset)}`
    );
  }
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
  const refs = Array.isArray(parsed.refs) ? parsed.refs.filter((r) => typeof r === 'string' && r.trim()) : [];
  if (majorOffset > 0) {
    if (reason.length < 20) {
      throw offsetError(
        'NO_REASON',
        `${OFFSET_FILE_NAME} claims majorOffset ${majorOffset} but gives no "reason". A Rust-only major is a permanent claim about a published crate; say which crate's public API broke.`
      );
    }
    if (refs.length === 0) {
      throw offsetError(
        'NO_REFS',
        `${OFFSET_FILE_NAME} claims majorOffset ${majorOffset} but lists no "refs". Name the issue or PR the breaking Rust change came from.`
      );
    }
  }
  return { majorOffset, reason, refs };
}

/**
 * Every workspace `package.json` under `packages/` and `apps/`.
 *
 * The warnings are not decoration. This list decides the release version: a
 * directory that silently fails to be read shrinks the scan, and a shrunken
 * scan syncs the whole release to a version LOWER than what was published.
 */
export function getWorkspacePackagePaths(rootDir) {
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
          if (error.code !== 'ENOENT') {
            console.warn(`⚠️  Could not stat ${pkgJsonPath}, excluding it from the version scan (${error.message})`);
          }
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`⚠️  Could not list ${parentDir}, excluding it from the version scan (${error.message})`);
      }
    }
  }
  return packages;
}

/**
 * The highest version across the non-private workspace packages and the root
 * `package.json` — the number this repo has always released at.
 *
 * Fails when the scan came back below the floor. The old code started from
 * `'0.0.0'` and had no floor, so a scan that found nothing produced a version
 * rather than an error.
 */
export function scanWorkspaceVersions(rootDir) {
  const paths = getWorkspacePackagePaths(rootDir);
  let maxVersion = null;
  let scanned = 0;
  for (const pkgPath of paths) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch (error) {
      console.warn(`⚠️  Could not read ${pkgPath}, excluding it from the version scan (${error.message})`);
      continue;
    }
    scanned++;
    if (pkg.private) continue;
    if (pkg.version && (maxVersion === null || compareSemver(pkg.version, maxVersion) > 0)) {
      maxVersion = pkg.version;
    }
  }
  if (scanned < MIN_WORKSPACE_PACKAGES) {
    throw offsetError(
      'PACKAGE_FLOOR',
      `the workspace scan read ${scanned} package.json file(s) under packages/ + apps/, below the floor of ${MIN_WORKSPACE_PACKAGES}. The release version is the maximum over that scan, so a scan this small would pick a version LOWER than what is published. Refusing rather than reporting one.`
    );
  }

  const rootPkgPath = join(rootDir, 'package.json');
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
  if (rootPkg.version && (maxVersion === null || compareSemver(rootPkg.version, maxVersion) > 0)) {
    maxVersion = rootPkg.version;
  }
  if (!parseSemver(maxVersion)) {
    throw offsetError(
      'BAD_VERSION',
      `the highest workspace version is ${JSON.stringify(maxVersion)}, which is not a \`major.minor.patch\` version`
    );
  }
  return { maxVersion, scanned, rootPkg, rootPkgPath };
}

/**
 * The two versions this release carries: the npm one changesets chose, and
 * the crate one the offset lifts it to. Both `sync-versions.js` (which writes
 * them) and the gate (which checks them) come through here, so there is one
 * definition of "the crate version" rather than two that must agree.
 */
export function computeReleaseVersions(rootDir) {
  const { majorOffset, reason, refs } = readMajorOffset(rootDir);
  const { maxVersion, scanned, rootPkg, rootPkgPath } = scanWorkspaceVersions(rootDir);
  return {
    npmVersion: maxVersion,
    crateVersion: applyMajorOffset(maxVersion, majorOffset),
    majorOffset,
    reason,
    refs,
    scanned,
    rootPkg,
    rootPkgPath,
  };
}
