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
 *
 * Source-text matching is comment-aware (rationale in
 * scripts/lib/server-bin-targets-parse.mjs); the upload check binds the asset
 * literal to the actual `gh release upload` argument. Executable proof:
 * scripts/check-server-bin-targets.test.mjs, which drives this script via
 * `--root <dir>` against hostile mutations of the real inputs.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  fail,
  jobBlock,
  parseMatrix,
  parseSupportedTargets,
  stripYamlComments,
  unquoteScalar,
} from './lib/server-bin-targets-parse.mjs';

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

/**
 * The exact expression the upload step must use for the asset filename.
 * The resolver downloads `ifc-lite-server-<target>.<ext>`; pinning the
 * workflow to this literal makes the two names provably identical instead
 * of two hand-maintained strings that agree by luck.
 */
// The ${{ }} is a GitHub Actions expression pinned as a literal, not a JS template.
// eslint-disable-next-line no-template-curly-in-string
const UPLOAD_ASSET_EXPR = 'ifc-lite-server-${{ matrix.target }}.${{ matrix.archive }}';

/**
 * The release upload step must BIND the asset name to UPLOAD_ASSET_EXPR and
 * every `gh release upload` invocation in it must pass exactly that binding.
 * Mere presence of the literal in the step is not enough: a comment can carry
 * the old name while the assignment or the upload argument drifts, and then
 * every release 404s on every platform while the gate blesses it.
 */
function checkUploadAssetName(workflow) {
  const block = jobBlock(workflow, 'release-server-binaries', WORKFLOW);
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

  // 1. The `asset=` binding must be exactly the expected expression and the
  // ONLY line writing the variable - a later `asset=` or `asset+=` would
  // rebind the name and reopen the hole the presence check had.
  const assigns = [...step.matchAll(/^[ \t]*asset(\+?=)(.*)$/gm)];
  if (assigns.length === 0) {
    fail(
      `the "Upload to GitHub Release" step in ${WORKFLOW} no longer assigns asset=...; the step must ` +
      `bind asset to "${UPLOAD_ASSET_EXPR}" (the exact name the resolver in ${PLATFORM_TS} downloads) - ` +
      `if the script was restructured, update this check`,
    );
  }
  if (assigns.length > 1) {
    fail(
      `the "Upload to GitHub Release" step in ${WORKFLOW} writes the asset variable ${assigns.length} ` +
      `times; a rebinding after the pinned assignment could upload a name the resolver in ` +
      `${PLATFORM_TS} never downloads, so exactly one asset= line is allowed`,
    );
  }
  const [, op, rawValue] = assigns[0];
  const assigned = unquoteScalar(rawValue.trim());
  if (op !== '=' || assigned !== UPLOAD_ASSET_EXPR) {
    fail(
      `the "Upload to GitHub Release" step in ${WORKFLOW} assigns asset${op}${rawValue.trim()} but the ` +
      `resolver in ${PLATFORM_TS} downloads exactly "${UPLOAD_ASSET_EXPR}"; the two must be identical`,
    );
  }

  // 2. Both paths (fresh release and backfill) must pass the $asset binding
  // as the `gh release upload` asset argument. Only double quotes are
  // stripped: a single-quoted '$asset' never expands in bash, so it must stay red.
  const uploads = [...step.matchAll(/gh release upload[ \t]+(\S+)[ \t]+(\S+)/g)];
  if (uploads.length < 2) {
    fail(
      `expected the release and backfill paths of the "Upload to GitHub Release" step in ${WORKFLOW} ` +
      `to each invoke "gh release upload <tag> <asset>"; found ${uploads.length} invocation(s) - ` +
      `if the step was restructured, update this check`,
    );
  }
  for (const [, , assetArg] of uploads) {
    const arg = assetArg.replace(/^"(.*)"$/s, '$1').replace(/^\$\{asset\}$/, '$asset');
    if (arg !== '$asset') {
      fail(
        `a "gh release upload" invocation in the "Upload to GitHub Release" step of ${WORKFLOW} passes ` +
        `${assetArg} as its asset argument instead of "$asset"; only the pinned $asset binding provably ` +
        `uploads the name the resolver in ${PLATFORM_TS} downloads`,
      );
    }
  }
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
  // expects, or the six correct archives upload under the wrong names.
  checkUploadAssetName(workflow);

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
