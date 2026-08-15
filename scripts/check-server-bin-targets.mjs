#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A server-bin release must carry one archive per platform the package
 * claims to support - and nothing verified that until v1.16.6 shipped
 * without ifc-lite-server-win32-x64.zip (issue #2619).
 *
 * Three functional lists encode the platform set and agreed only by hand:
 *
 *   1. SUPPORTED_TARGETS in packages/server-bin/src/platform.ts - the six
 *      real target triples the install-time resolver accepts.
 *   2. `os` / `cpu` in packages/server-bin/package.json - what npm gates
 *      installs on. This is a strictly COARSER cross-product than the
 *      triples: it admits win32-arm64 (npm checks os and cpu independently)
 *      and cannot express linux-x64-musl at all. So the invariant is not
 *      triple-for-triple: `os` must equal the set of platform prefixes in
 *      SUPPORTED_TARGETS, and `cpu` must equal the set of arches with any
 *      `-musl` suffix stripped.
 *   3. The `release-server-binaries` matrix in
 *      .github/workflows/server-binaries.yml - what actually gets built and
 *      uploaded. Its target set must equal SUPPORTED_TARGETS, and each
 *      entry's `archive` must match the resolver's naming rule (win32 =>
 *      zip, else tar.gz), which is what makes the workflow's
 *      `ifc-lite-server-<target>.<archive>` provably the same string the
 *      resolver downloads.
 *
 * The `validate-server-binaries` matrix is a deliberate cost-saving SUBSET
 * (linux only), so it is checked as a subset, not for equality.
 *
 * With `--release <tag>` the script instead asserts the published release
 * carries every expected archive by name, so a failed matrix leg cannot
 * leave a silent hole.
 *
 * Fail-closed: an unfindable list, a parse yielding no entries, or an
 * unreadable/empty release asset list is an ERROR, never a vacuous pass.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORM_TS = 'packages/server-bin/src/platform.ts';
const PKG_JSON = 'packages/server-bin/package.json';
const WORKFLOW = '.github/workflows/server-binaries.yml';

function fail(message) {
  console.error(`check-server-bin-targets: ERROR: ${message}`);
  process.exit(1);
}

/** Archive extension the install-time resolver derives for a triple. */
function archiveExtFor(platform) {
  return platform === 'win32' ? 'zip' : 'tar.gz';
}

/** Split "<platform>-<arch>[-musl]" or fail. */
function splitTriple(triple) {
  const m = triple.match(/^([a-z0-9]+)-([a-z0-9]+)(-musl)?$/);
  if (!m) {
    fail(`unrecognised target triple "${triple}" (expected <platform>-<arch>[-musl])`);
  }
  return { platform: m[1], arch: m[2] };
}

function assertSetEquals(label, actual, expected) {
  const missing = [...expected].filter((v) => !actual.has(v));
  const extra = [...actual].filter((v) => !expected.has(v));
  if (missing.length || extra.length) {
    const parts = [];
    if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
    if (extra.length) parts.push(`unexpected: ${extra.join(', ')}`);
    fail(`${label} disagrees with SUPPORTED_TARGETS (${parts.join('; ')})`);
  }
}

/** Parse the SUPPORTED_TARGETS set literal out of platform.ts. */
function parseSupportedTargets() {
  const source = readFileSync(join(repoRoot, PLATFORM_TS), 'utf8');
  const m = source.match(/const SUPPORTED_TARGETS = new Set\(\[([^\]]*)\]\)/);
  if (!m) {
    fail(
      `cannot find the "const SUPPORTED_TARGETS = new Set([...])" list in ${PLATFORM_TS}; ` +
      `if the const moved or was renamed, update this check - it must not pass without the list`,
    );
  }
  const targets = [...m[1].matchAll(/'([^']+)'/g)].map((q) => q[1]);
  if (targets.length < 2) {
    fail(`parsed only ${targets.length} target(s) from SUPPORTED_TARGETS in ${PLATFORM_TS}; refusing a vacuous pass`);
  }
  return targets;
}

/** Extract one job's block from the workflow (2-space-indented job keys). */
function jobBlock(source, jobName) {
  const start = new RegExp(`^  ${jobName}:[ \\t]*$`, 'm').exec(source);
  if (!start) {
    fail(`cannot find job "${jobName}" in ${WORKFLOW}; if it was renamed, update this check`);
  }
  const bodyStart = start.index + start[0].length;
  const next = /^  [A-Za-z0-9_-]+:/m.exec(source.slice(bodyStart));
  return next ? source.slice(bodyStart, bodyStart + next.index) : source.slice(bodyStart);
}

/** Parse `- target:` / `archive:` pairs from a job's matrix include list. */
function parseMatrix(source, jobName, { requireArchive }) {
  const block = jobBlock(source, jobName);
  const includeIdx = block.indexOf('include:');
  const steps = /^    steps:/m.exec(block);
  if (includeIdx === -1 || !steps || steps.index < includeIdx) {
    fail(`cannot find the matrix include list in job "${jobName}" of ${WORKFLOW}`);
  }
  const section = block.slice(includeIdx, steps.index);
  const anchors = [...section.matchAll(/- target:[ \t]*([^\s]+)/g)];
  if (anchors.length === 0) {
    fail(`matrix include list in job "${jobName}" of ${WORKFLOW} yielded zero targets; refusing a vacuous pass`);
  }
  return anchors.map((anchor, i) => {
    const end = i + 1 < anchors.length ? anchors[i + 1].index : section.length;
    const chunk = section.slice(anchor.index, end);
    const archive = chunk.match(/archive:[ \t]*([^\s]+)/);
    if (requireArchive && !archive) {
      fail(`matrix entry "${anchor[1]}" in job "${jobName}" of ${WORKFLOW} has no archive: key`);
    }
    return { target: anchor[1], archive: archive ? archive[1] : null };
  });
}

/** Default mode: the three functional lists must agree. */
function checkSourceParity() {
  const targets = parseSupportedTargets();
  const targetSet = new Set(targets);

  // package.json os/cpu: prefix/arch projection of the triples.
  const pkg = JSON.parse(readFileSync(join(repoRoot, PKG_JSON), 'utf8'));
  if (!Array.isArray(pkg.os) || !Array.isArray(pkg.cpu)) {
    fail(`${PKG_JSON} has no "os"/"cpu" arrays; the npm install gate is gone`);
  }
  const expectedOs = new Set(targets.map((t) => splitTriple(t).platform));
  const expectedCpu = new Set(targets.map((t) => splitTriple(t).arch));
  assertSetEquals(`${PKG_JSON} "os"`, new Set(pkg.os), expectedOs);
  assertSetEquals(`${PKG_JSON} "cpu"`, new Set(pkg.cpu), expectedCpu);

  const workflow = readFileSync(join(repoRoot, WORKFLOW), 'utf8');

  // Release matrix: exact target equality plus the resolver's archive rule.
  const release = parseMatrix(workflow, 'release-server-binaries', { requireArchive: true });
  assertSetEquals(`${WORKFLOW} release-server-binaries matrix`, new Set(release.map((e) => e.target)), targetSet);
  for (const entry of release) {
    const expectedExt = archiveExtFor(splitTriple(entry.target).platform);
    if (entry.archive !== expectedExt) {
      fail(
        `release matrix entry "${entry.target}" archives as "${entry.archive}" but the resolver ` +
        `in ${PLATFORM_TS} downloads "ifc-lite-server-${entry.target}.${expectedExt}"`,
      );
    }
  }

  // Validate matrix: a deliberate cost-saving subset, never an unknown target.
  const validate = parseMatrix(workflow, 'validate-server-binaries', { requireArchive: false });
  for (const entry of validate) {
    if (!targetSet.has(entry.target)) {
      fail(`validate-server-binaries matrix names "${entry.target}", which is not in SUPPORTED_TARGETS`);
    }
  }

  console.log(
    `check-server-bin-targets: OK - ${targets.length} targets ` +
    `(${targets.join(', ')}) agree across ${PLATFORM_TS}, ${PKG_JSON} and ${WORKFLOW}`,
  );
  return targets;
}

/** Owner/repo slug, derived from the package manifest rather than hardcoded. */
function repoSlug() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, PKG_JSON), 'utf8'));
  const m = String(pkg.repository?.url ?? '').match(/github\.com[/:]([^/]+\/[^/.]+)/);
  if (!m) fail(`cannot derive the GitHub repo slug from ${PKG_JSON} repository.url`);
  return m[1];
}

/** Release asset names via gh, falling back to the REST API when gh is absent. */
async function fetchReleaseAssetNames(tag) {
  try {
    const out = execFileSync('gh', ['release', 'view', tag, '--json', 'assets'], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    if (!Array.isArray(parsed.assets)) fail(`gh release view ${tag} returned no assets array`);
    return parsed.assets.map((a) => a.name);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      fail(`could not read release ${tag} via gh: ${err?.message ?? err}`);
    }
  }
  const url = `https://api.github.com/repos/${repoSlug()}/releases/tags/${encodeURIComponent(tag)}`;
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'ifc-lite-check-server-bin-targets',
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) fail(`GitHub API returned ${res.status} for release ${tag} (${url})`);
  const body = await res.json();
  if (!Array.isArray(body.assets)) fail(`GitHub API response for release ${tag} has no assets array`);
  return body.assets.map((a) => a.name);
}

/**
 * --release mode: every expected archive must exist on the release, by the
 * exact name the resolver downloads. Deliberately does NOT expect .sha256 /
 * SHA256SUMS sidecars: no workflow publishes them today, so expecting them
 * would turn every release red.
 */
async function checkReleaseAssets(tag) {
  const targets = checkSourceParity();
  const names = await fetchReleaseAssetNames(tag);
  if (names.length === 0) {
    fail(`release ${tag} has no assets at all; an empty list is a failure, not a pass`);
  }
  const expected = targets.map((t) => `ifc-lite-server-${t}.${archiveExtFor(splitTriple(t).platform)}`);
  const missing = expected.filter((name) => !names.includes(name));
  if (missing.length) {
    fail(
      `release ${tag} is missing ${missing.length} of ${expected.length} expected archives:\n` +
      missing.map((name) => `  ${name}`).join('\n'),
    );
  }
  console.log(`check-server-bin-targets: OK - release ${tag} carries all ${expected.length} expected archives`);
}

const args = process.argv.slice(2);
const releaseIdx = args.indexOf('--release');
if (releaseIdx !== -1) {
  const tag = args[releaseIdx + 1];
  if (!tag || tag.startsWith('--')) fail('--release requires a tag argument (e.g. --release v1.16.6)');
  await checkReleaseAssets(tag);
} else {
  checkSourceParity();
}
