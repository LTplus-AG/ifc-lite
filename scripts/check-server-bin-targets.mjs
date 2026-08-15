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
 *      uploaded. Its target set must equal SUPPORTED_TARGETS, each entry's
 *      `archive` must match the resolver's naming rule (win32 => zip, else
 *      tar.gz), and each entry's `rust-target` must be the triple the
 *      install target actually needs - a wrong triple ships an incompatible
 *      binary under a perfectly valid archive name (arm64 bits as x64).
 *      The upload step must also use the literal
 *      `ifc-lite-server-${{ matrix.target }}.${{ matrix.archive }}`
 *      expression, which is what makes the uploaded name provably the same
 *      string the resolver downloads rather than agreeing by luck.
 *
 * The `validate-server-binaries` matrix is a deliberate cost-saving SUBSET
 * (linux only), so it is checked as a subset, not for equality.
 *
 * With `--release <tag>` the script instead asserts the published release
 * carries every expected archive by name, so a failed matrix leg cannot
 * leave a silent hole. The expected set is read from the TAG'S OWN
 * platform.ts (`git show refs/tags/<tag>:...`), not from the checked-out
 * tree: a manual backfill dispatch checks out the workflow ref (main), and
 * as the platform set drifts, main's SUPPORTED_TARGETS would demand
 * archives an old release never claimed to ship (a false red on exactly
 * the repair path this check exists for) or miss ones it still needs (a
 * false green). The checked-out tree still gets the full source-parity
 * check first, and the checker code itself always runs from the workflow
 * ref.
 *
 * Fail-closed: an unfindable list, a parse yielding no entries, an
 * unreadable/empty release asset list, or a release tag whose ref is not
 * available locally is an ERROR, never a vacuous pass. In particular an
 * absent tag ref tells the operator to fetch it instead of silently
 * falling back to the checked-out tree's target set.
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
  return { platform: m[1], arch: m[2], musl: Boolean(m[3]) };
}

/**
 * The rust triple a matrix entry must build for an install target. Derived,
 * not hardcoded: platform and arch map 1:1 onto the rust triple's components
 * and `-musl` selects the musl libc. An underivable platform or arch is an
 * ERROR, never a skip, so a brand-new target cannot enter the matrix without
 * this mapping learning about it first.
 */
function rustTripleFor(target) {
  const { platform, arch, musl } = splitTriple(target);
  const rustArch = { x64: 'x86_64', arm64: 'aarch64' }[arch];
  if (!rustArch) {
    fail(`no rust-triple mapping for arch "${arch}" (target "${target}"); teach this check the new arch before adding the target`);
  }
  if (musl && platform !== 'linux') {
    fail(`target "${target}" uses -musl on non-linux platform "${platform}"; no rust triple exists for that`);
  }
  switch (platform) {
    case 'linux':
      return `${rustArch}-unknown-linux-${musl ? 'musl' : 'gnu'}`;
    case 'darwin':
      return `${rustArch}-apple-darwin`;
    case 'win32':
      return `${rustArch}-pc-windows-msvc`;
    default:
      fail(`no rust-triple mapping for platform "${platform}" (target "${target}"); teach this check the new platform before adding the target`);
  }
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

/** Parse the SUPPORTED_TARGETS set literal out of platform.ts source text. */
function parseSupportedTargets(source, origin = PLATFORM_TS) {
  const m = source.match(/const SUPPORTED_TARGETS = new Set\(\[([^\]]*)\]\)/);
  if (!m) {
    fail(
      `cannot find the "const SUPPORTED_TARGETS = new Set([...])" list in ${origin}; ` +
      `if the const moved or was renamed, update this check - it must not pass without the list`,
    );
  }
  const targets = [...m[1].matchAll(/'([^']+)'/g)].map((q) => q[1]);
  if (targets.length < 2) {
    fail(`parsed only ${targets.length} target(s) from SUPPORTED_TARGETS in ${origin}; refusing a vacuous pass`);
  }
  return targets;
}

/**
 * SUPPORTED_TARGETS as of the release tag's own source. A release is
 * verified against what ITS resolver downloads: the install-time resolver
 * ships inside the published package at that version, so the tag's
 * platform.ts is the contract, and the checked-out tree's may have drifted
 * (a backfill dispatch checks out the workflow ref, not the tag). The
 * tag's package.json os/cpu is deliberately not consulted here - it only
 * gates npm installs, cannot change which archives the tag's resolver
 * downloads, and is unfixable post-publish anyway.
 *
 * Fail-closed: an absent tag ref is an ERROR telling the operator to fetch
 * it, never a silent fallback to the checked-out tree's set - that
 * fallback would recreate the vacuous pass this script exists to prevent.
 */
function parseTagSupportedTargets(tag) {
  let source;
  try {
    source = execFileSync('git', ['show', `refs/tags/${tag}:${PLATFORM_TS}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = String(err?.stderr || err?.message || err).trim().split('\n')[0];
    fail(
      `cannot read ${PLATFORM_TS} at tag "${tag}" via git show (${detail}); ` +
      `fetch the tag first (git fetch --depth=1 origin tag ${tag}) - refusing to fall back ` +
      `to the checked-out tree's target set, which may not be the tag's`,
    );
  }
  return parseSupportedTargets(source, `${PLATFORM_TS} at tag ${tag}`);
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

/** Parse `- target:` / `rust-target:` / `archive:` tuples from a job's matrix include list. */
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
    const rustTarget = chunk.match(/rust-target:[ \t]*([^\s]+)/);
    if (!rustTarget) {
      fail(
        `matrix entry "${anchor[1]}" in job "${jobName}" of ${WORKFLOW} has no rust-target: key; ` +
        `refusing a vacuous pass - without it nothing pins which triple that leg builds`,
      );
    }
    return { target: anchor[1], archive: archive ? archive[1] : null, rustTarget: rustTarget[1] };
  });
}

/**
 * The exact expression the upload step must use for the asset filename.
 * The resolver downloads `ifc-lite-server-<target>.<ext>`; pinning the
 * workflow to this literal makes the two names provably identical instead
 * of two hand-maintained strings that agree by luck.
 */
// The ${{ }} is a GitHub Actions expression pinned as a literal, not a JS template.
// eslint-disable-next-line no-template-curly-in-string
const UPLOAD_ASSET_EXPR = 'ifc-lite-server-${{ matrix.target }}.${{ matrix.archive }}';

/** The release upload step must name its asset via UPLOAD_ASSET_EXPR. */
function checkUploadAssetName(workflow) {
  const block = jobBlock(workflow, 'release-server-binaries');
  const stepStart = block.indexOf('- name: Upload to GitHub Release');
  if (stepStart === -1) {
    fail(
      `cannot find the "Upload to GitHub Release" step in job "release-server-binaries" of ${WORKFLOW}; ` +
      `if the step was renamed, update this check - it must not pass without pinning the upload filename`,
    );
  }
  const rest = block.slice(stepStart + 1);
  const nextStep = /\n {6}- name:/.exec(rest);
  const step = block.slice(stepStart, nextStep ? stepStart + 1 + nextStep.index : block.length);
  if (!step.includes(UPLOAD_ASSET_EXPR)) {
    fail(
      `the "Upload to GitHub Release" step in ${WORKFLOW} does not use the literal asset expression ` +
      `"${UPLOAD_ASSET_EXPR}"; the resolver in ${PLATFORM_TS} downloads exactly that name, so the ` +
      `upload must provably produce it`,
    );
  }
}

/** Default mode: the three functional lists must agree. */
function checkSourceParity() {
  const targets = parseSupportedTargets(readFileSync(join(repoRoot, PLATFORM_TS), 'utf8'));
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

  // Release matrix: exact target equality, the resolver's archive rule, and
  // the target-to-rust-triple mapping (a wrong triple ships an incompatible
  // binary under a perfectly valid archive name).
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
    const expectedTriple = rustTripleFor(entry.target);
    if (entry.rustTarget !== expectedTriple) {
      fail(
        `release matrix entry "${entry.target}" builds rust-target "${entry.rustTarget}" but the ` +
        `install target requires "${expectedTriple}"; the archive name would be valid while the ` +
        `binary inside it targets the wrong platform`,
      );
    }
  }

  // The upload step must name assets with the exact expression the resolver
  // expects, or the six correct archives upload under the wrong names.
  checkUploadAssetName(workflow);

  // Validate matrix: a deliberate cost-saving subset, never an unknown
  // target, and its legs must build the triple their target names.
  const validate = parseMatrix(workflow, 'validate-server-binaries', { requireArchive: false });
  for (const entry of validate) {
    if (!targetSet.has(entry.target)) {
      fail(`validate-server-binaries matrix names "${entry.target}", which is not in SUPPORTED_TARGETS`);
    }
    const expectedTriple = rustTripleFor(entry.target);
    if (entry.rustTarget !== expectedTriple) {
      fail(
        `validate matrix entry "${entry.target}" builds rust-target "${entry.rustTarget}" but the ` +
        `target maps to "${expectedTriple}"; that leg would validate the wrong platform's build`,
      );
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
 * exact name the resolver downloads. The expected set is the TAG's own
 * SUPPORTED_TARGETS (see parseTagSupportedTargets); the checked-out tree is
 * still source-parity-checked first, since on a `release` event it IS the
 * tag and on a backfill it is the gated workflow ref. Deliberately does NOT
 * expect .sha256 / SHA256SUMS sidecars: no workflow publishes them today,
 * so expecting them would turn every release red.
 */
async function checkReleaseAssets(tag) {
  checkSourceParity();
  const targets = parseTagSupportedTargets(tag);
  const names = await fetchReleaseAssetNames(tag);
  if (names.length === 0) {
    fail(`release ${tag} has no assets at all; an empty list is a failure, not a pass`);
  }
  const expected = targets.map((t) => `ifc-lite-server-${t}.${archiveExtFor(splitTriple(t).platform)}`);
  const missing = expected.filter((name) => !names.includes(name));
  if (missing.length) {
    fail(
      `release ${tag} is missing ${missing.length} of ${expected.length} archives its own SUPPORTED_TARGETS names:\n` +
      missing.map((name) => `  ${name}`).join('\n'),
    );
  }
  console.log(
    `check-server-bin-targets: OK - release ${tag} carries all ${expected.length} archives ` +
    `its own SUPPORTED_TARGETS names (${targets.join(', ')})`,
  );
}

const args = process.argv.slice(2);
const releaseIdx = args.indexOf('--release');
if (releaseIdx !== -1) {
  const tag = args[releaseIdx + 1];
  // Reject a leading '-' outright: the tag is passed as an argv to gh, where
  // it would parse as a flag (git refnames cannot start with '-' anyway).
  if (!tag || tag.startsWith('-')) fail('--release requires a tag argument (e.g. --release v1.16.6)');
  await checkReleaseAssets(tag);
} else {
  checkSourceParity();
}
