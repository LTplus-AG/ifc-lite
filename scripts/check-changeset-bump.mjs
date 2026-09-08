#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A pending changeset may not declare `patch` for a package whose published
 * export surface SHRANK since the last release.
 *
 * WHY THIS EXISTS: PR #3175 (`fix(changesets): correct twelve semver bumps that
 * would have shipped breaking changes as patch`, commit fb55a6ea7) corrected
 * TWELVE changeset frontmatters BY HAND, with the release "one command from
 * publishing". bcf, ifcx, sdk and wasm would each have shipped a breaking
 * change as `patch` or `minor`. The root cause was not that someone reasoned
 * wrongly about semver; it was that NOTHING AND NOBODY LOOKED. CodeRabbit was
 * rate-limited across the 42-PR batch, 39 of 41 PRs carried no review on their
 * head commit, and both human review passes were aimed at code and tests.
 * Changesets were the one artifact class with no reader — automated or human.
 *
 * #3175 corrected the values and added NO gate, so the hole it found was still
 * open when this was written. This is that gate.
 *
 * THE RULE IS AGENTS.md's, NOT GENERIC SEMVER. AGENTS.md line 68 (under
 * "Changesets & published API"):
 *
 *   Bump level = biggest API change: removing/renaming an export is `major`
 *   (>=1.0 pkg) or `minor` (0.x), never `patch` when the surface shrank.
 *
 * That differs from generic semver in the 0.x branch — plain semver leaves 0.x
 * unconstrained and many projects ship breaking 0.x changes as patch — and it
 * differs from RELEASE.md's shorter rubric. Where they disagree, AGENTS.md
 * wins, because AGENTS.md is what #3175 cited when it derived each of the
 * twelve corrections. This gate encodes AGENTS.md and nothing else.
 *
 * WHAT IT COMPARES, AND WHY NOT THE OBVIOUS THING
 *
 * The obvious reading of "compare the current surface against the recorded
 * baseline in scripts/api-surface.json" produces a gate that CANNOT FAIL.
 * `scripts/check-api-surface.mjs` extracts the live surface from the built
 * d.ts files and exits 1 unless it deep-equals the committed snapshot (see its
 * final `if (dirty)`), and CI runs it in the node-tests job. So on any tree
 * green enough to reach this gate, "current surface" and "the snapshot" are
 * THE SAME OBJECT, and diffing them is a measurement with a fixed point at
 * zero. Reusing that script's `extractSurface` would also drag in a full
 * `pnpm build`, since it reads each package's built `dist` declarations.
 *
 * So the two sides here are both snapshots, separated in TIME:
 *
 *   baseline = scripts/api-surface.json at the last `chore: version packages`
 *              commit — the release commit that DRAINED .changeset/ (the
 *              message is pinned in .github/workflows/release.yml:267).
 *   current  = scripts/api-surface.json in the working tree.
 *
 * That anchor is chosen because it makes the two populations line up exactly:
 * every changeset now sitting in .changeset/ was written after it, and every
 * byte of surface drift since it is unreleased. Anchoring on the merge base
 * with main instead would only ever see the CURRENT PR's own removal, which is
 * the wrong window for the #3175 failure — that was a BATCH of 90 pending
 * changesets accumulated from dozens of merged PRs, and the release was the
 * first moment anything looked at them together. Anchored at the release, this
 * gate is equally useful on a PR (your removal is in the accumulated drift) and
 * at release time (so is everyone else's).
 *
 * THE TEETH — three failure classes, three DIFFERENT remedies. They are spelled
 * out separately on purpose: this repo has a recorded lesson that a gate whose
 * remedy contradicts its finding is worse than no gate.
 *
 *  1. UNDER-BUMPED. The surface shrank, a pending changeset names the package,
 *     and its highest declared bump is below what AGENTS.md:68 requires.
 *     REMEDY: raise the level in the named changeset file(s). Do NOT restore
 *     the export to make the gate green — if the removal was deliberate (and
 *     `pnpm api-surface:update` having been run says it was), the bump is the
 *     thing that has to move, not the code. This is the exact class of all
 *     twelve #3175 corrections.
 *
 *  2. UNDECLARED. The surface shrank and NO pending changeset names the package
 *     at all. REMEDY: `pnpm changeset`, select the package, choose the required
 *     level. This is a different hole from (1), not a milder one: with no
 *     changeset naming it, Changesets releases the package only as a dependency
 *     bump if at all, so a removed export ships under a version number that
 *     claims nothing happened. Raising some OTHER package's changeset does not
 *     fix it.
 *
 *  3. REFUSALS (anti-vacuity). No release anchor in history; a baseline that
 *     cannot be read; a shrunk package with no readable version. Each exits
 *     non-zero with a named reason rather than passing. A guard that cannot
 *     find its own inputs and says nothing is indistinguishable from a guard
 *     that found nothing wrong, and this repo has been burned by that shape
 *     enough times to write it down.
 *
 * "No pending changesets" is a clean pass ONLY when nothing shrank. It is
 * deliberately NOT an early return, and the ordering matters: right after a
 * release both the changeset count and the drift are zero, so the shortcut
 * would look correct forever — and the first time someone removed an export
 * without writing a changeset, the absence of the changeset would be read as
 * proof of nothing to check. Drift is computed FIRST; the changeset count only
 * decides which of the two failure messages a shrink gets.
 *
 * WHAT COUNTS AS "THE SURFACE SHRANK"
 *
 * A snapshot entry is `"Name: kind"` (e.g. `"writeBCF: function"`,
 * `"BCFBitmap: interface"`). Two things gate:
 *
 *   REMOVED     a NAME in the baseline that is absent from the current
 *               snapshot, including every name of a surface key that
 *               disappeared whole. A rename lands here too, as the old name's
 *               removal — which is why this gate does not try to pair a removal
 *               with an addition by string similarity. It does not need to: the
 *               removal alone is the breaking half, and a similarity heuristic
 *               would only add a way to be wrong.
 *   DEMOTED     a name whose kind gained the `(type-only)` marker. That marker
 *               is `check-api-surface.mjs`'s own encoding for a value export
 *               turned `export type` — its docblock calls it "a runtime API
 *               removal that TS erases". The name survives; the runtime binding
 *               does not, so it is a shrink.
 *
 * A kind change that is NOT a type-only demotion (`Foo: class` -> `Foo: type`)
 * is REPORTED but does not gate. Whether it breaks a consumer depends on which
 * capability was lost, and this gate has no measured basis for that lattice —
 * inventing one would mean gating on a rule nobody wrote down. The report keeps
 * it visible for a human; the silence is deliberate, not an oversight.
 *
 * WHAT THIS GATE CANNOT SEE — and it is most of #3175
 *
 * State this plainly, because it is the honest limit: the snapshot records
 * NAMES AND KINDS, not signatures or behaviour. Of the twelve bumps #3175
 * corrected, this gate would have caught the ones that dropped or demoted an
 * exported name, and NOT the ones that broke a still-exported symbol:
 *
 *   - `writeBCF` throws where it returned a Blob     -> invisible (same name,
 *                                                      same kind)
 *   - `export_step_json` String -> Result<String,_>  -> invisible (return type)
 *   - `getRecommendedScale` throws on 0/NaN          -> invisible (narrowed
 *                                                      input domain)
 *
 * So this closes ONE lane of the #3175 hole, the mechanically checkable one.
 * The rest still needs a reader. Do not cite a green run of this gate as
 * evidence that a batch of changesets has been reviewed; it is evidence about
 * export names and nothing else. A gate that overstates its own coverage is how
 * the next batch ships unread.
 *
 * Two further blind spots, stated rather than discovered later:
 *   - It reads only `packages/*`, because `scripts/api-surface.json` does.
 *     `apps/*` members that Changesets versions (e.g. `@ifc-lite/viewer`) have
 *     no snapshot and are not checked.
 *   - It cannot see a Rust-side break. `@ifc-lite/wasm`'s snapshot is its
 *     committed `pkg/ifc-lite.d.ts`, so a signature change inside a `pub use`
 *     — precisely the `export_step_json` case — does not move it.
 *
 * WIRING REQUIREMENT — READ BEFORE ADDING THIS TO A JOB
 *
 * The baseline is read from git history, so the checkout must REACH the last
 * `chore: version packages` commit. `actions/checkout` defaults to
 * `fetch-depth: 1`, and every job in .github/workflows/test.yml except the
 * push-event one at line 74 takes that default — HEAD with no ancestors at all.
 * Wired into such a job unchanged, this gate refuses on every single run, and a
 * gate that is always red is a gate someone deletes.
 *
 * So the job that runs this needs `fetch-depth: 0` on its checkout (or a
 * targeted `git fetch --deepen` far enough back; the anchor is typically a few
 * dozen commits, but nothing bounds it, so depth 0 is the only setting that
 * cannot silently become too shallow). That is a real CI cost on a repo this
 * size and it is a deliberate choice, which is why it is stated here rather
 * than left for whoever sees the first red.
 *
 * The refusal names this case specifically — it asks
 * `git rev-parse --is-shallow-repository` and says so — because "no anchor
 * found" and "the clone cannot see the anchor" have different remedies and
 * would otherwise print the same sentence.
 *
 * Run:   node scripts/check-changeset-bump.mjs
 * Flags (development and the test harness only; CI passes none):
 *   --root <dir>            read .changeset/ and packages/ from this tree
 *   --current-file <path>   current snapshot (default <root>/scripts/api-surface.json)
 *   --baseline-file <path>  baseline snapshot, instead of deriving it from git
 *   --baseline-ref <ref>    git ref to read the baseline from, instead of the
 *                           derived release anchor
 */

import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import parseChangeset from '@changesets/parse';
import { listWorkspacePackages } from './lib/list-workspace-packages.mjs';
import { existsOrThrow } from './lib/exists-or-throw.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, '..');

/** Commit subject the changesets action writes (.github/workflows/release.yml:267). */
const RELEASE_SUBJECT = '^chore: version packages';

/** AGENTS.md:68 admits exactly these three; `none` is a Changesets level too. */
const RANK = { none: 0, patch: 1, minor: 2, major: 3 };

function flag(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i === -1 || i + 1 >= process.argv.length ? fallback : process.argv[i + 1];
}

const ROOT = flag('--root', REPO_ROOT);
const CHANGESET_DIR = join(ROOT, '.changeset');

/**
 * The named-refusal path: a class, a message, a remedy, exit 1.
 *
 * SCOPE, stated because the previous wording claimed more than the code does:
 * this is not the ONLY non-zero exit. `packageVersions()` throws a raw Error
 * through its injected callback, and the unreadable-changesets block prints and
 * exits 1 directly. Both still fail closed, so nothing is unsound -- but they
 * exit without a refusal CLASS, so do not read a green run as proof that every
 * exit path is routed through here.
 */
function refuse(what, why, remedy) {
  console.error(`❌ changeset-bump gate refused to run: ${what}\n`);
  console.error(`   ${why}\n`);
  console.error(`   ${remedy}\n`);
  console.error(
    '   Refusing rather than passing: a gate that cannot read its own inputs\n' +
      '   and stays quiet is indistinguishable from one that found nothing wrong.',
  );
  process.exit(1);
}

/**
 * The last release commit reachable from HEAD.
 *
 * Matched on BOTH the pinned subject and a touch of `.changeset/`, because
 * neither alone is safe: `git log --grep` is line-oriented over the whole
 * message, so a PR body quoting the release title matches it, and plenty of
 * ordinary commits delete a changeset (dc1c71632 removed one to unbreak the
 * Release workflow). The conjunction is what makes this an anchor.
 */
function releaseAnchor() {
  const res = spawnSync(
    'git',
    [
      '-C',
      ROOT,
      'log',
      '-1',
      '--extended-regexp',
      `--grep=${RELEASE_SUBJECT}`,
      '--format=%H',
      'HEAD',
      '--',
      '.changeset',
    ],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) return { error: (res.stderr || '').trim() || `git exited ${res.status}` };
  const sha = res.stdout.trim();
  if (sha) return { sha };
  // Empty output with a ZERO exit is the dangerous one, and it is the case CI
  // hits by default: `actions/checkout` clones at fetch-depth 1, so HEAD has no
  // ancestors, `git log --grep` succeeds and matches nothing, and "no anchor"
  // is indistinguishable from "no drift" unless something asks. Ask.
  const shallow = spawnSync('git', ['-C', ROOT, 'rev-parse', '--is-shallow-repository'], {
    encoding: 'utf8',
  });
  return {
    error: 'no commit in HEAD history matches the release anchor',
    shallow: shallow.status === 0 && shallow.stdout.trim() === 'true',
  };
}

function readSnapshotAtRef(ref) {
  const res = spawnSync('git', ['-C', ROOT, 'show', `${ref}:scripts/api-surface.json`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    return { error: (res.stderr || '').trim() || `git show exited ${res.status}` };
  }
  try {
    return { snapshot: JSON.parse(res.stdout) };
  } catch (err) {
    return { error: `${ref}:scripts/api-surface.json is not valid JSON: ${err.message}` };
  }
}

function readSnapshotFile(path) {
  try {
    return { snapshot: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (err) {
    return { error: `${path}: ${err.message}` };
  }
}

/** `"writeBCF: function"` -> `{ name, kind }`. A name may not contain ": ". */
function splitEntry(entry) {
  const at = entry.indexOf(': ');
  return at === -1
    ? { name: entry, kind: '' }
    : { name: entry.slice(0, at), kind: entry.slice(at + 2) };
}

/**
 * Surface key -> package name. Keys are either `@scope/pkg` or a published
 * subpath of one (`@ifc-lite/clash/bcf`), and a shrink in a subpath is a shrink
 * in the package that publishes it — the changeset names the package, never the
 * subpath.
 */
function packageOf(surfaceKey) {
  const parts = surfaceKey.split('/');
  return surfaceKey.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Per package: which exported names went away, and which were demoted to
 * type-only. Both are shrinks. Kind changes that are neither are collected
 * separately and only reported.
 */
function surfaceShrink(baseline, current) {
  const byPackage = new Map();
  const record = (key, field, value) => {
    const pkg = packageOf(key);
    if (!byPackage.has(pkg)) {
      byPackage.set(pkg, { removed: [], demoted: [], kindChanged: [] });
    }
    byPackage.get(pkg)[field].push(value);
  };

  for (const [key, beforeList] of Object.entries(baseline)) {
    const before = new Map(
      (beforeList ?? []).map((e) => {
        const { name, kind } = splitEntry(e);
        return [name, kind];
      }),
    );
    // A surface key absent from `current` is the whole entry point gone — every
    // name in it is removed. Not a refusal: `check-api-surface.mjs` reports the
    // same shape as "export surface no longer published", and it is a shrink.
    const after = new Map(
      (current[key] ?? []).map((e) => {
        const { name, kind } = splitEntry(e);
        return [name, kind];
      }),
    );
    for (const [name, beforeKind] of before) {
      if (!after.has(name)) {
        record(key, 'removed', { key, entry: `${name}: ${beforeKind}` });
        continue;
      }
      const afterKind = after.get(name);
      if (afterKind === beforeKind) continue;
      const wasTypeOnly = beforeKind.includes('(type-only)');
      const isTypeOnly = afterKind.includes('(type-only)');
      if (!wasTypeOnly && isTypeOnly) {
        record(key, 'demoted', { key, name, beforeKind, afterKind });
      } else {
        record(key, 'kindChanged', { key, name, beforeKind, afterKind });
      }
    }
  }
  return byPackage;
}

/**
 * Versions, via the shared workspace walk the other fail-closed gates use
 * (`scripts/lib/list-workspace-packages.mjs`). `packages` only: that is the
 * whole population `scripts/api-surface.json` covers, so scanning `apps` would
 * build a map with nothing to look up in it.
 */
function packageVersions() {
  const { packages } = listWorkspacePackages(ROOT, (m) => {
    throw new Error(m);
  }, ['packages']);
  const versions = new Map();
  for (const { pkgJson } of packages) {
    if (pkgJson?.name) versions.set(pkgJson.name, pkgJson.version);
  }
  return versions;
}

/**
 * AGENTS.md:68, and only that. `>=1.0` reads the MAJOR of the version currently
 * in package.json — the last RELEASED version, since Changesets bumps at
 * release time — which is the version a consumer's range is pinned against and
 * therefore the one the rule is about.
 */
function requiredBump(version) {
  const major = Number.parseInt(String(version).split('.')[0], 10);
  if (!Number.isFinite(major)) return null;
  return major >= 1 ? 'major' : 'minor';
}

/** name -> { max, declarations: [{ file, type }] } over every pending changeset. */
function pendingBumps() {
  // TWO guards, because they catch different things and the first one alone is
  // INERT against the case that matters. existsOrThrow separates "absent" from
  // "unreadable" at STAT level, which catches ENOTDIR (a file where the
  // directory belongs) and EIO. It does NOT catch a locked directory: statSync
  // SUCCEEDS on a chmod-000 directory -- stat needs execute on the parent, not
  // read on the directory -- so EACCES arrives at readdirSync instead, and an
  // unguarded readdirSync there crashes with a stack trace rather than a named
  // reason. Verified by chmod 000 on `.changeset/`: with only the stat guard the
  // gate died in node:fs, never reaching its own refusal.
  //
  // SCOPE, narrowed to what this actually guarantees: these guards cover an
  // UNREADABLE .changeset/, not an ABSENT one. A directory that is simply not
  // there still returns an empty list and this gate can still exit 0 -- but only
  // when nothing shrank, because the surface half runs regardless of how many
  // changesets are pending, and a shrink with zero changesets is a FAILURE here
  // (pinned by test). So the silent case is "no directory AND no surface change",
  // which is benign. Absence of the directory itself is check-changesets.mjs's
  // question, not this gate's.
  const dirRemedy =
    'Fix the permissions or the path and re-run. Do NOT work around this by ' +
    'deleting the directory: an ABSENT .changeset/ is a different state from an ' +
    'unreadable one, and this gate treats them differently on purpose.';
  if (
    !existsOrThrow(CHANGESET_DIR, 'the changeset directory', (m) =>
      refuse('CHANGESET_DIR_UNREADABLE', m, dirRemedy),
    )
  ) {
    return { files: [], byPackage: new Map(), unreadable: [] };
  }
  let entries;
  try {
    entries = readdirSync(CHANGESET_DIR);
  } catch (err) {
    refuse(
      'CHANGESET_DIR_UNREADABLE',
      `cannot list the changeset directory ${CHANGESET_DIR}: ${err.code || err.message}. ` +
        'Refusing to report "no pending changesets" for a directory this gate could not read.',
      dirRemedy,
    );
  }
  const files = entries
    // The README exclusion is a REGEX rather than a string, and that is
    // load-bearing rather than style. check-ci-path-coverage.mjs derives a
    // gate's inputs LEXICALLY from path-shaped string literals anywhere in the
    // source, comments included. A quoted lowercase spelling of the README file
    // name was therefore derived as an input this gate supposedly reads. It does
    // not read that file, it EXCLUDES it, so the entry needed an exemption -- and
    // the exemption then behaved differently per platform. On a case-insensitive
    // macOS filesystem the lowercase spelling resolves to the real file and the
    // exemption is used; on Linux it resolves to nothing, the derived input
    // disappears, and the row becomes a STALE exemption, which that allowlist
    // treats as a failure. Local runs passed and CI failed on exactly that.
    // A regex is not a path literal, so nothing is derived and no row is needed.
    .filter((f) => f.endsWith('.md') && !/^readme\.md$/i.test(f))
    .sort();
  const byPackage = new Map();
  const unreadable = [];
  for (const file of files) {
    let releases;
    try {
      // Parsed with the library Changesets itself uses, for the reason
      // check-changesets.mjs records: a regex over the frontmatter silently
      // returns nothing for the unquoted `pkg: patch` spelling that Changesets
      // accepts, so the guard would pass the exact input it exists to catch.
      releases = parseChangeset(readFileSync(join(CHANGESET_DIR, file), 'utf8')).releases;
    } catch (err) {
      unreadable.push({ file, error: err.message });
      continue;
    }
    for (const { name, type } of releases) {
      if (!byPackage.has(name)) byPackage.set(name, { max: 'none', declarations: [] });
      const slot = byPackage.get(name);
      slot.declarations.push({ file, type });
      if ((RANK[type] ?? 0) > (RANK[slot.max] ?? 0)) slot.max = type;
    }
  }
  return { files, byPackage, unreadable };
}

// ---------------------------------------------------------------------------

const currentPath = flag('--current-file', join(ROOT, 'scripts', 'api-surface.json'));
const currentRead = readSnapshotFile(currentPath);
if (currentRead.error) {
  refuse(
    'the current API-surface snapshot is unreadable',
    currentRead.error,
    'Run `pnpm api-surface:update` and commit scripts/api-surface.json.',
  );
}

let baselineRead;
let baselineLabel;
const baselineFile = flag('--baseline-file');
const baselineRef = flag('--baseline-ref');
// Whether the footer may claim the baseline IS the last release. Under
// --baseline-file / --baseline-ref it is whatever the caller pointed at, and a
// sentence that stays true only on the default path is the kind of locally-true,
// generally-phrased claim this repo keeps getting bitten by.
let baselineIsDerivedAnchor = false;
if (baselineFile) {
  baselineRead = readSnapshotFile(baselineFile);
  baselineLabel = baselineFile;
} else {
  let ref = baselineRef;
  if (!ref) {
    const anchor = releaseAnchor();
    if (anchor.error) {
      refuse(
        'no release anchor found in history',
        `Looked for the most recent HEAD ancestor whose subject matches ` +
          `/${RELEASE_SUBJECT}/ and that touches .changeset/: ${anchor.error}.` +
          (anchor.shallow ? '\n   This clone is SHALLOW, which is almost certainly why.' : ''),
        anchor.shallow
          ? 'The checkout must reach back to the last `chore: version packages` ' +
            'commit.\n   In CI that means `fetch-depth: 0` on the actions/checkout ' +
            'step for this\n   job (the default is 1, which leaves HEAD with no ' +
            'ancestors at all); locally,\n   `git fetch --unshallow`.'
          : 'Pass --baseline-ref <ref> to pin the baseline by hand — a fork ' +
            'branched\n   before the first release legitimately has no anchor.',
      );
    }
    ref = anchor.sha;
    baselineIsDerivedAnchor = true;
  }
  baselineRead = readSnapshotAtRef(ref);
  baselineLabel = `${ref.slice(0, 9)}:scripts/api-surface.json`;
}
if (baselineRead.error) {
  refuse(
    'the baseline API-surface snapshot is unreadable',
    baselineRead.error,
    'Pass --baseline-ref <ref> to pin a readable baseline, or deepen the clone.',
  );
}

const shrinkByPackage = surfaceShrink(baselineRead.snapshot, currentRead.snapshot);
const { files, byPackage: declared, unreadable } = pendingBumps();

if (unreadable.length > 0) {
  console.error('❌ These changesets could not be read as changesets:\n');
  for (const { file, error } of unreadable) console.error(`   .changeset/${file}: ${error}`);
  console.error(
    '\nA bump level that cannot be parsed cannot be checked. Fix the frontmatter\n' +
      '(`--- "@ifc-lite/pkg": patch ---`); `pnpm lint` reports the same thing.',
  );
  process.exit(1);
}

const shrunk = [...shrinkByPackage.entries()].filter(
  ([, s]) => s.removed.length > 0 || s.demoted.length > 0,
);
const advisory = [...shrinkByPackage.entries()].filter(([, s]) => s.kindChanged.length > 0);

if (shrunk.length === 0) {
  for (const [pkg, s] of advisory) {
    console.log(`ℹ️  ${pkg}: export kind changed (not gated, see this script's header)`);
    for (const k of s.kindChanged) {
      console.log(`      ${k.name}: ${k.beforeKind} -> ${k.afterKind}   (${k.key})`);
    }
  }
  console.log(
    `changeset-bump: ${files.length} pending changeset(s); no published export removed or ` +
      `demoted since ${baselineLabel}.`,
  );
  process.exit(0);
}

const versions = packageVersions();
const missingVersion = shrunk.map(([pkg]) => pkg).filter((pkg) => !versions.has(pkg));
if (missingVersion.length > 0) {
  refuse(
    'a package whose surface shrank has no readable version',
    `scripts/api-surface.json names ${missingVersion.join(', ')}, but no ` +
      `packages/*/package.json under ${ROOT} declares that name.`,
    'AGENTS.md:68 picks major-vs-minor from the version, so this cannot be ' +
      'decided. Re-run `pnpm api-surface:update` if the package moved or was ' +
      'renamed.',
  );
}

const underBumped = [];
const undeclared = [];
for (const [pkg, s] of shrunk) {
  const version = versions.get(pkg);
  const required = requiredBump(version);
  if (required === null) {
    refuse(
      `${pkg} has an unparseable version`,
      `packages/*/package.json declares version ${JSON.stringify(version)}.`,
      'AGENTS.md:68 selects major-vs-minor from the major component; fix the version.',
    );
  }
  const slot = declared.get(pkg);
  if (!slot) {
    undeclared.push({ pkg, version, required, shrink: s });
    continue;
  }
  if ((RANK[slot.max] ?? 0) < RANK[required]) {
    underBumped.push({ pkg, version, required, declared: slot, shrink: s });
  }
}

function printShrink(s) {
  for (const r of s.removed) {
    console.error(`      removed  ${r.entry}   (${r.key})`);
  }
  for (const d of s.demoted) {
    console.error(
      `      demoted  ${d.name}: ${d.beforeKind} -> ${d.afterKind}   (${d.key})` +
        '  — value export erased at runtime',
    );
  }
}

let failed = false;

if (underBumped.length > 0) {
  failed = true;
  console.error(
    '❌ Pending changesets declare too small a bump for a SHRUNK export surface.\n' +
      '   AGENTS.md:68: removing/renaming an export is `major` (>=1.0 pkg) or\n' +
      '   `minor` (0.x), never `patch` when the surface shrank.\n',
  );
  for (const { pkg, version, required, declared: slot, shrink } of underBumped) {
    console.error(`   ${pkg}@${version}   declared: ${slot.max}   required: ${required}`);
    for (const { file, type } of slot.declarations) {
      console.error(`      .changeset/${file}  ->  ${type}`);
    }
    printShrink(shrink);
    console.error('');
  }
  console.error(
    'REMEDY: raise the level in the changeset file(s) listed above to the required\n' +
      'level. Do NOT restore the removed export to make this green — the snapshot\n' +
      'was updated deliberately (`pnpm api-surface:update`), so the bump is what is\n' +
      'wrong, not the code. This is the exact correction PR #3175 (fb55a6ea7) had to\n' +
      'make twelve times by hand, with the release one command from publishing.\n',
  );
}

if (undeclared.length > 0) {
  failed = true;
  console.error(
    '❌ A published export surface SHRANK with no pending changeset naming the\n' +
      '   package at all.\n',
  );
  for (const { pkg, version, required, shrink } of undeclared) {
    console.error(`   ${pkg}@${version}   declared: (no changeset)   required: ${required}`);
    printShrink(shrink);
    console.error('');
  }
  console.error(
    'REMEDY: run `pnpm changeset`, select the package(s) above, and choose the\n' +
      'required level. This is NOT the same fix as raising an existing changeset:\n' +
      'with nothing naming the package, Changesets releases it only as a dependency\n' +
      'bump if at all, so the removal ships under a version that claims nothing\n' +
      'happened.\n',
  );
}

if (failed) {
  console.error(
    `Baseline: ${baselineLabel}` +
      (baselineIsDerivedAnchor
        ? ' — the last `chore: version packages` commit, where\n' +
          '.changeset/ was last drained, so pending changesets and unreleased surface\n' +
          'drift cover the same window.'
        : ' — supplied on the command line, NOT the derived release anchor.'),
  );
  process.exit(1);
}

for (const [pkg, s] of advisory) {
  console.log(`ℹ️  ${pkg}: export kind changed (not gated, see this script's header)`);
  for (const k of s.kindChanged) {
    console.log(`      ${k.name}: ${k.beforeKind} -> ${k.afterKind}   (${k.key})`);
  }
}
console.log(
  `changeset-bump: ${files.length} pending changeset(s); ${shrunk.length} package(s) shrank ` +
    `since ${baselineLabel}, each with a sufficient bump:`,
);
for (const [pkg, s] of shrunk) {
  const slot = declared.get(pkg);
  console.log(
    `   ${pkg}@${versions.get(pkg)}  ${slot.max} >= ${requiredBump(versions.get(pkg))}  ` +
      `(${s.removed.length} removed, ${s.demoted.length} demoted)`,
  );
}
