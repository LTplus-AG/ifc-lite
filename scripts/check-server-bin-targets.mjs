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
 * carries every expected asset by name, so a failed matrix leg cannot
 * leave a silent hole. The expected set is read from the TAG'S OWN
 * platform.ts (`git show refs/tags/<tag>:...`), not from the checked-out
 * tree: a manual backfill dispatch checks out the workflow ref (main), and
 * as the platform set drifts, main's SUPPORTED_TARGETS would demand
 * archives an old release never claimed to ship (a false red on exactly
 * the repair path this check exists for) or miss ones it still needs (a
 * false green). The .sha256 sidecar expectation is keyed off the tag the
 * same way: expected exactly when the tag's own workflow publishes
 * sidecars, so pre-sidecar releases stay verifiable while a newer release
 * cannot silently drop one (checksum.ts fails closed for those versions).
 * The checked-out tree still gets the full source-parity check first, and
 * the checker code itself always runs from the workflow ref.
 *
 * Fail-closed: an unfindable list, a parse yielding no entries, an
 * unreadable/empty release asset list, or a release tag whose ref is not
 * available locally is an ERROR, never a vacuous pass. In particular an
 * absent tag ref tells the operator to fetch it instead of silently
 * falling back to the checked-out tree's target set.
 *
 * Source-text matching is comment-aware (rationale in
 * scripts/lib/server-bin-targets-parse.mjs); the upload check (in
 * scripts/lib/server-bin-upload-check.mjs) binds the asset and sidecar
 * literals to the actual `gh release upload` arguments. Executable proof:
 * scripts/check-server-bin-targets.test.mjs, which drives this script via
 * `--root <dir>` against hostile mutations of the real inputs.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  fail,
  parseMatrix,
  parseSupportedTargets,
  stripYamlComments,
} from './lib/server-bin-targets-parse.mjs';
import {
  checkUploadStep,
  uploadStepPublishesSidecars,
} from './lib/server-bin-upload-check.mjs';

// --root <dir>: read the input files from an alternate tree (in --release
// mode, git also runs there). Exists for the regression harness, which points
// the UNMODIFIED checker at mutated copies of the real inputs; CI never
// passes it.
const rootFlagIdx = process.argv.indexOf('--root');
if (rootFlagIdx !== -1 && !process.argv[rootFlagIdx + 1]) {
  fail('--root requires a directory argument');
}
const repoRoot = rootFlagIdx === -1
  ? join(dirname(fileURLToPath(import.meta.url)), '..')
  : resolve(process.argv[rootFlagIdx + 1]);
const PLATFORM_TS = 'packages/server-bin/src/platform.ts';
const PKG_JSON = 'packages/server-bin/package.json';
const WORKFLOW = '.github/workflows/server-binaries.yml';

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

/**
 * Read one file at the release tag's own revision via git show.
 *
 * Fail-closed: an absent tag ref is an ERROR telling the operator to fetch
 * it, never a silent fallback to the checked-out tree - that fallback would
 * recreate the vacuous pass this script exists to prevent. A path that does
 * not exist at an EXISTING tag is a different, answerable case: the caller
 * may treat it as a definite absence, so it is surfaced as null when
 * `optional` is set.
 */
function readFileAtTag(tag, path, { optional = false } = {}) {
  try {
    return execFileSync('git', ['show', `refs/tags/${tag}:${path}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = String(err?.stderr || err?.message || err).trim().split('\n')[0];
    if (optional && /does not exist/.test(detail)) return null;
    fail(
      `cannot read ${path} at tag "${tag}" via git show (${detail}); ` +
      `fetch the tag first (git fetch --depth=1 origin tag ${tag}) - refusing to fall back ` +
      `to the checked-out tree, which may not be the tag's`,
    );
  }
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
 */
function parseTagSupportedTargets(tag) {
  const source = readFileAtTag(tag, PLATFORM_TS);
  return parseSupportedTargets(source, `${PLATFORM_TS} at tag ${tag}`);
}

/**
 * Whether the TAG's own pipeline publishes checksum sidecars, read from the
 * tag's server-binaries.yml the same way the target set is read from the
 * tag's platform.ts. Keying the sidecar expectation off the tag is what lets
 * pre-sidecar releases (e.g. v1.16.6) stay verifiable without demanding
 * assets they never claimed to ship, while a release cut from sidecar-
 * publishing source cannot silently drop one. An absent workflow, job, step
 * or binding at the tag is a definite "no sidecars", not an error; the
 * strict counterpart (checkUploadStep, which fails closed on all of those)
 * has already run against the checked-out tree by the time this is called,
 * so a drifted binding on the workflow ref turns the gate red instead of
 * silently disarming this detection for future releases.
 */
function tagWorkflowPublishesSidecars(tag) {
  const source = readFileAtTag(tag, WORKFLOW, { optional: true });
  if (source === null) return false;
  return uploadStepPublishesSidecars(stripYamlComments(source));
}

/** Default mode: the three functional lists must agree. */
function checkSourceParity() {
  const targets = parseSupportedTargets(readFileSync(join(repoRoot, PLATFORM_TS), 'utf8'), PLATFORM_TS);
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

  // Comments stripped up front: a commented-out matrix entry or upload line counts as absent.
  const workflow = stripYamlComments(readFileSync(join(repoRoot, WORKFLOW), 'utf8'));

  // Release matrix: exact target equality, the resolver's archive rule, and
  // the target-to-rust-triple mapping (a wrong triple ships an incompatible
  // binary under a perfectly valid archive name).
  const release = parseMatrix(workflow, 'release-server-binaries', WORKFLOW, { requireArchive: true });
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
  // expects (or the six correct archives upload under the wrong names) and
  // must ship a .sha256 sidecar with every archive (or the fail-closed
  // install-time verification in checksum.ts breaks every install).
  checkUploadStep(workflow, WORKFLOW, PLATFORM_TS);

  // Validate matrix: a deliberate cost-saving subset, never an unknown
  // target, and its legs must build the triple their target names.
  const validate = parseMatrix(workflow, 'validate-server-binaries', WORKFLOW, { requireArchive: false });
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
 * --release mode: every expected asset must exist on the release, by the
 * exact name the resolver downloads. The expected set is the TAG's own
 * SUPPORTED_TARGETS (see parseTagSupportedTargets); the checked-out tree is
 * still source-parity-checked first, since on a `release` event it IS the
 * tag and on a backfill it is the gated workflow ref. One .sha256 sidecar
 * per archive is expected exactly when the tag's own workflow publishes
 * sidecars (see tagWorkflowPublishesSidecars): the install-time check in
 * checksum.ts fails closed for such versions, so a missing sidecar breaks
 * every install of that platform just as surely as a missing archive -
 * while pre-sidecar releases never claimed to ship one.
 */
async function checkReleaseAssets(tag) {
  checkSourceParity();
  const targets = parseTagSupportedTargets(tag);
  const sidecars = tagWorkflowPublishesSidecars(tag);
  const names = await fetchReleaseAssetNames(tag);
  if (names.length === 0) {
    fail(`release ${tag} has no assets at all; an empty list is a failure, not a pass`);
  }
  const archives = targets.map((t) => `ifc-lite-server-${t}.${archiveExtFor(splitTriple(t).platform)}`);
  const expected = sidecars ? archives.flatMap((a) => [a, `${a}.sha256`]) : archives;
  const missing = expected.filter((name) => !names.includes(name));
  if (missing.length) {
    const kind = sidecars ? 'assets (one archive plus one .sha256 sidecar per target)' : 'archives';
    fail(
      `release ${tag} is missing ${missing.length} of ${expected.length} ${kind} its own SUPPORTED_TARGETS names:\n` +
      missing.map((name) => `  ${name}`).join('\n'),
    );
  }
  console.log(
    `check-server-bin-targets: OK - release ${tag} carries all ${archives.length} archives ` +
    (sidecars
      ? `and ${archives.length} checksum sidecars its own SUPPORTED_TARGETS names (${targets.join(', ')})`
      : `its own SUPPORTED_TARGETS names (${targets.join(', ')}; tag predates checksum sidecars, none required)`),
  );
}

const args = process.argv.slice(2);
const rootIdx = args.indexOf('--root');
if (rootIdx !== -1) args.splice(rootIdx, 2);
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
