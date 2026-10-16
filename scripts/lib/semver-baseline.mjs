/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A reproducible semver BASELINE for a published crate whose crates.io
 * release can no longer be resolved (#7737).
 *
 * `cargo-semver-checks --baseline-version X` builds the baseline from a
 * placeholder project that depends on `crate = "=X"` and resolves it FRESH,
 * with no lockfile. A published release keeps its dependency requirements
 * forever, so once every version a requirement admits is yanked the baseline
 * stops resolving: `ifc-lite-export` 20.4.0 declares optional `zip = "^8"`
 * (enabled by `parquet-bos`), all of zip 8.x is yanked, and the run exits 101
 * before it compares anything. Skipping the feature or reading that NO_VERDICT
 * as a pass would remove the check, so neither is done here.
 *
 * What is done instead: the baseline rustdoc is rebuilt from the git release
 * tag the crate was published from, `--locked` against that tag's own
 * Cargo.lock (a lockfile may pin a yanked version; only fresh resolution
 * refuses one), and handed to the tool as `--baseline-rustdoc`. That build is
 * only a baseline if it IS the published source, so before anything is built
 * every workspace crate in the baseline's dependency closure is downloaded
 * from crates.io, its archive checksum is checked against the sparse index,
 * and its packaged files are compared byte for byte with the tag. Any
 * difference fails closed.
 *
 * Tag mapping: the crates run `majorOffset` majors ahead of npm
 * (rust-major-offset.json), and release tags carry the npm version, so crate
 * 20.4.0 is tag `v(20 - k).4.0` for the offset k in force then. Every k up to
 * today's offset is tried and a candidate only counts when the tag's own
 * Cargo.toml says this crate version AND its own offset file says k.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEMVER_TOOLCHAIN, runSemverChecks } from './cargo-semver-checks.mjs';
import { USER_AGENT, sparseIndexPath } from './crates-io.mjs';
import { readMajorOffset } from './rust-major-offset.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Did this run fail because crates.io's copy of the BASELINE no longer
 * resolves? The dependency line names the placeholder's exact-version
 * requirement on the baseline, which is what separates it from the current
 * crate failing (that one is a `path dependency`) or from any other error.
 */
export function isUnresolvableRegistryBaseline(output, crate, baseline) {
  if (typeof output !== 'string') return false;
  const resolverFailed = /failed to select a version for|no matching package named/.test(output);
  return resolverFailed && output.includes(`\`${crate} = "=${baseline}"\``);
}

/** Every release tag crate `version` could have come from, one per offset. */
export function releaseTagCandidates(version, maxOffset) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m || !Number.isInteger(maxOffset) || maxOffset < 0) return [];
  const out = [];
  for (let offset = 0; offset <= maxOffset && Number(m[1]) - offset >= 0; offset += 1) {
    out.push({ tag: `v${Number(m[1]) - offset}.${m[2]}.${m[3]}`, offset });
  }
  return out;
}

/** Does a tag's tree publish crate `version` under `offset`? A tag that
 *  predates rust-major-offset.json (`offsetJson` null) ran at offset 0. */
export function tagPublishes({ cargoToml, offsetJson }, version, offset) {
  const declared = cargoToml?.match(/\[workspace\.package\][^[]*?version\s*=\s*"([^"]+)"/)?.[1];
  let tagOffset = 0;
  if (offsetJson != null) {
    try {
      tagOffset = JSON.parse(offsetJson).majorOffset;
    } catch {
      return false;
    }
  }
  return declared === version && tagOffset === offset;
}

/**
 * cargo-semver-checks 0.50.0's default feature set (`rustdoc_gen.rs`,
 * `heuristically_included_features`): every `[features]` entry plus every
 * optional dependency not hidden behind `dep:`, minus `unstable`, `nightly`,
 * `bench`, `no_std` and anything prefixed `_`, `unstable-` or `unstable_`.
 * The current crate is built with this set, so the baseline must be too, or
 * an item behind `parquet-bos` would read as added or removed.
 */
export function heuristicFeatures(pkg) {
  const features = pkg?.features ?? {};
  const hidden = new Set(
    Object.values(features).flat().filter((f) => f.startsWith('dep:')).map((f) => f.slice(4))
  );
  const names = new Set(Object.keys(features));
  for (const dep of pkg?.dependencies ?? []) {
    const name = dep.rename ?? dep.name;
    if (dep.optional && !hidden.has(name)) names.add(name);
  }
  const ignored = new Set(['unstable', 'nightly', 'bench', 'no_std']);
  return [...names]
    .filter((f) => !ignored.has(f) && !['_', 'unstable-', 'unstable_'].some((p) => f.startsWith(p)))
    .sort();
}

/** Files cargo writes into the archive rather than copying from the tree. */
const GENERATED = new Set(['.cargo_vcs_info.json', 'Cargo.toml', 'Cargo.lock']);

/**
 * Every way a published archive and the tag disagree, as readable lines.
 * `packaged` is the archive's files; `tagged` is the tag's crate directory
 * keyed the way cargo would package it (its manifest as `Cargo.toml.orig`, a
 * readme outside the crate under its basename). Both directions matter for
 * `src/` and `build.rs`: a source file only the tag has is code the published
 * crate never compiled.
 */
export function diffPackagedSources(packaged, tagged) {
  const out = [];
  for (const [rel, bytes] of packaged) {
    if (GENERATED.has(rel)) continue;
    const at = tagged.get(rel);
    if (!at) out.push(`${rel}: published, but absent at the tag`);
    else if (!at.equals(bytes)) out.push(`${rel}: published bytes differ from the tag`);
  }
  for (const rel of tagged.keys()) {
    if ((rel.startsWith('src/') || rel === 'build.rs') && !packaged.has(rel)) {
      out.push(`${rel}: at the tag, but not in the published crate`);
    }
  }
  return out.sort();
}

/**
 * One crate's run, against crates.io's baseline when it resolves and against
 * the baseline rebuilt from its release tag when it does not. Returns
 * `{ run, via }` for the caller to interpret (`via` names the rebuilt
 * baseline, null for the registry one), or `{ failure }` naming why nothing
 * could be compared. Every other failure is left in `run` for the caller's
 * NO_VERDICT: only an unresolvable BASELINE is something a rebuild can fix.
 */
export function runWithReproducibleBaseline(crate, baseline, runSemverChecks, runTagBaseline) {
  const registryRun = runSemverChecks(crate, baseline);
  if (!isUnresolvableRegistryBaseline(registryRun.output, crate, baseline)) return { run: registryRun, via: null };
  const cause =
    registryRun.output.match(/failed to select a version for[^\n]*/)?.[0] ??
    registryRun.output.match(/no matching package named[^\n]*/)?.[0];
  const head = `UNRESOLVABLE_BASELINE: crates.io's ${crate} ${baseline} no longer resolves (${cause})`;
  if (!runTagBaseline) {
    return { failure: `${head}, and no tag-baseline builder is wired, so nothing was compared` };
  }
  try {
    const run = runTagBaseline(crate, baseline);
    return { run, via: run.via };
  } catch (err) {
    return { failure: `${head}, and rebuilding it from its release tag failed, so nothing was compared. ${err.message}` };
  }
}

/* ------------------------------ real wiring ------------------------------ */

function sh(bin, args, opts = {}) {
  const res = spawnSync(bin, args, { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 * 1024, ...opts });
  const text = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : b || '');
  return { status: res.status ?? -1, stdout: res.stdout, err: text(res.stderr) + (res.error?.message ?? '') };
}

function must(res, what) {
  if (res.status !== 0) {
    const tail = res.err.trim().split('\n').slice(-15).join('\n      | ');
    throw new Error(`${what} failed (exit ${res.status}):\n      | ${tail}`);
  }
  return res.stdout;
}

const gitShow = (tag, path) => {
  const res = sh('git', ['show', `${tag}:${path}`], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout : null;
};

/** The release tag crate `version` was published from, fetched if absent. */
export function findReleaseTag(version) {
  const candidates = releaseTagCandidates(version, readMajorOffset(REPO_ROOT).majorOffset);
  const local = (tag) => sh('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`]).status === 0;
  const missing = candidates.filter((c) => !local(c.tag)).map((c) => `refs/tags/${c.tag}`);
  if (missing.length > 0) {
    const listed = { stdout: must(sh('git', ['ls-remote', 'origin', ...missing], { encoding: 'utf8' }), 'git ls-remote origin') };
    const shallow = sh('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' });
    const depth = shallow.stdout?.trim() === 'true' ? ['--depth=1'] : [];
    for (const ref of (listed.stdout || '').match(/refs\/tags\/\S+/g) ?? []) {
      must(sh('git', ['fetch', '-q', '--no-tags', ...depth, 'origin', `+${ref}:${ref}`]), `git fetch ${ref}`);
    }
  }
  const found = candidates.filter(
    (c) =>
      local(c.tag) &&
      tagPublishes(
        { cargoToml: gitShow(c.tag, 'Cargo.toml'), offsetJson: gitShow(c.tag, 'rust-major-offset.json') },
        version,
        c.offset
      )
  );
  if (found.length !== 1) {
    throw new Error(
      `BASELINE_TAG_NOT_FOUND: ${found.length} release tags publish crate version ${version} ` +
        `(tried ${candidates.map((c) => `${c.tag}@offset ${c.offset}`).join(', ')}); exactly one must.`
    );
  }
  const commit = must(sh('git', ['rev-parse', `refs/tags/${found[0].tag}^{commit}`], { encoding: 'utf8' }), 'git rev-parse').trim();
  return { tag: found[0].tag, commit };
}

function walk(root, dir = root, out = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, abs, out);
    else if (entry.isFile()) out.set(relative(root, abs).split('\\').join('/'), readFileSync(abs));
  }
  return out;
}

function curl(url, args = []) {
  return must(sh('curl', ['-fsSL', '--retry', '3', '-A', USER_AGENT, ...args, url]), `curl ${url}`);
}

/** Download crate@version, check its sha256 against the sparse index, and
 *  compare its files with the tag's copy. Returns the vcs commit it names. */
function verifyPublished(pkg, treeRoot, workDir) {
  const { name, version } = pkg;
  const index = curl(`https://index.crates.io/${sparseIndexPath(name)}`).toString('utf8');
  const entry = index.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.vers === version);
  if (!entry) throw new Error(`BASELINE_SOURCE_MISMATCH: ${name} ${version} is not in the crates.io index.`);
  const archive = curl(`https://static.crates.io/crates/${name}/${name}-${version}.crate`);
  const sha = createHash('sha256').update(archive).digest('hex');
  if (sha !== entry.cksum) {
    throw new Error(`BASELINE_SOURCE_MISMATCH: ${name} ${version} downloaded as sha256 ${sha}, index says ${entry.cksum}.`);
  }
  const out = join(workDir, 'published', `${name}-${version}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  must(sh('tar', ['-xzf', '-', '-C', out], { input: archive }), `extract ${name}-${version}.crate`);
  const packaged = walk(join(out, `${name}-${version}`));

  const crateDir = dirname(pkg.manifest_path);
  const tagged = walk(crateDir);
  tagged.set('Cargo.toml.orig', tagged.get('Cargo.toml'));
  tagged.delete('Cargo.toml');
  for (const extra of [pkg.readme, pkg.license_file].filter(Boolean)) {
    const abs = resolve(crateDir, extra);
    if (existsSync(abs)) tagged.set(basename(extra), readFileSync(abs));
  }
  const diffs = diffPackagedSources(packaged, tagged);
  const vcs = JSON.parse(packaged.get('.cargo_vcs_info.json')?.toString('utf8') ?? '{}');
  const inVcs = relative(treeRoot, crateDir).split('\\').join('/');
  if (vcs.path_in_vcs !== undefined && vcs.path_in_vcs !== inVcs) {
    diffs.push(`.cargo_vcs_info.json: packaged from ${vcs.path_in_vcs}, the tag has the crate at ${inVcs}`);
  }
  if (diffs.length > 0) {
    throw new Error(
      `BASELINE_SOURCE_MISMATCH: the tag is not the published ${name} ${version} ` +
        `(sha256 ${sha}):\n      | ${diffs.slice(0, 12).join('\n      | ')}`
    );
  }
  return vcs.git?.sha1 ?? null;
}

/** Workspace packages `root` needs to build (normal and build edges only). */
function workspaceClosure(meta, root) {
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set([root.id]);
  const queue = [root.id];
  while (queue.length > 0) {
    for (const dep of nodes.get(queue.shift())?.deps ?? []) {
      const linked = dep.dep_kinds.some((k) => k.kind === null || k.kind === 'build');
      if (linked && byId.get(dep.pkg)?.source == null && !seen.has(dep.pkg)) {
        seen.add(dep.pkg);
        queue.push(dep.pkg);
      }
    }
  }
  return [...seen].map((id) => byId.get(id));
}

const prepared = new Map();

/** Extract the tag's workspace and read its locked metadata, once per tag. */
function prepareTree(version, toolchain) {
  if (prepared.has(version)) return prepared.get(version);
  const { tag, commit } = findReleaseTag(version);
  const workDir = join(process.env.CARGO_TARGET_DIR || join(REPO_ROOT, 'target'), 'semver-checks', 'tag-baseline', tag);
  const treeRoot = join(workDir, 'tree');
  rmSync(treeRoot, { recursive: true, force: true });
  mkdirSync(treeRoot, { recursive: true });
  const memberList = gitShow(tag, 'Cargo.toml')?.match(/^members\s*=\s*\[([^\]]*)\]/m)?.[1] ?? '';
  const members = [...memberList.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (gitShow(tag, 'Cargo.lock') == null) {
    throw new Error(`BASELINE_NO_LOCKFILE: ${tag} has no Cargo.lock, so a --locked rebuild cannot reproduce it.`);
  }
  const paths = ['Cargo.toml', 'Cargo.lock', '.cargo', 'README.md', 'LICENSE', ...members].filter(
    (p) => sh('git', ['cat-file', '-e', `${tag}:${p}`]).status === 0
  );
  const tar = must(sh('git', ['archive', '--format=tar', tag, '--', ...paths]), `git archive ${tag}`);
  must(sh('tar', ['-xf', '-', '-C', treeRoot], { input: tar }), `extract ${tag}`);
  const manifest = join(treeRoot, 'Cargo.toml');
  const meta = JSON.parse(
    must(
      sh('cargo', [`+${toolchain}`, 'metadata', '--locked', '--format-version', '1', '--manifest-path', manifest], {
        encoding: 'utf8',
      }),
      `cargo metadata --locked at ${tag}`
    )
  );
  const state = { tag, commit, workDir, treeRoot, manifest, meta, verified: new Map() };
  prepared.set(version, state);
  return state;
}

/**
 * Build crate@version's baseline rustdoc JSON from its release tag, after
 * proving the tag is what crates.io serves. Returns `{ rustdoc, via }`;
 * throws a named reason on any step that would make the baseline unsound.
 */
export function buildTagBaselineRustdoc(crate, version, toolchain) {
  const s = prepareTree(version, toolchain);
  const pkg = s.meta.packages.find((p) => p.name === crate && p.version === version && p.source == null);
  if (!pkg) throw new Error(`BASELINE_TAG_NOT_FOUND: ${s.tag} has no workspace crate ${crate} ${version}.`);
  const closure = workspaceClosure(s.meta, pkg);
  for (const dep of closure) {
    if (!s.verified.has(dep.name)) s.verified.set(dep.name, verifyPublished(dep, s.treeRoot, s.workDir));
  }
  const commits = new Set(closure.map((p) => s.verified.get(p.name)).filter(Boolean));
  const features = heuristicFeatures(pkg);
  const targetDir = join(s.workDir, 'target');
  const rustdoc = join(targetDir, 'doc', `${crate.replace(/-/g, '_')}.json`);
  rmSync(rustdoc, { force: true }); // never compare against a JSON an earlier run left behind
  must(
    sh(
      'cargo',
      [`+${toolchain}`, 'doc', '--locked', '--manifest-path', s.manifest, '--target-dir', targetDir,
        '--package', `${crate}@${version}`, '--lib', '--no-deps', '--color', 'never',
        ...(features.length > 0 ? ['--features', features.join(',')] : [])],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          RUSTC_BOOTSTRAP: '1',
          // cargo-semver-checks 0.50.0's own flags (data_generation/generate.rs).
          RUSTDOCFLAGS: '-Z unstable-options --document-private-items --document-hidden-items --output-format=json --cap-lints=allow',
        },
      }
    ),
    `cargo doc ${crate}@${version} at ${s.tag}`
  );
  if (!existsSync(rustdoc)) throw new Error(`BASELINE_BUILD_FAILED: cargo doc wrote no ${rustdoc}.`);
  const vcs = commits.size === 1 && commits.has(s.commit) ? 'the tag commit' : [...commits].join(', ') || 'unrecorded';
  return {
    rustdoc,
    via:
      `${s.tag} (${s.commit.slice(0, 10)}), --locked; ${closure.length} crate(s) byte-equal to ` +
      `crates.io (${closure.map((p) => p.name).sort().join(', ')}; packaged from ${vcs}); ` +
      `features ${features.join(',') || '(none)'}`,
  };
}

/** The real `runTagBaseline`: the same cargo-semver-checks run, against the rebuilt baseline. */
export function runAgainstTagBaseline(crate, baseline) {
  const { rustdoc, via } = buildTagBaselineRustdoc(crate, baseline, SEMVER_TOOLCHAIN);
  return { ...runSemverChecks(crate, baseline, { baselineRustdoc: rustdoc }), via };
}
