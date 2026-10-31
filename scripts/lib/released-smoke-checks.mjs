/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Pure archive/lock checks for scripts/smoke-released-retained.mjs (#7955). */
import { realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';

export const NPM_REGISTRY = 'https://registry.npmjs.org/';
const WASM_ALLOWED = new Set(['pkg/ifc-lite_bg.wasm', 'pkg-diff/ifc-lite-diff_bg.wasm']);
const BINARY_EXT = /\.(node|so|dylib|dll|exe|a|o|rlib)$/i;
const SDK_PATH = /(^|\/)(smlib|usd-brep|sdk)\//i;
const SDK_FILE = /ifclite_smlib|smlib.*\.(wasm|node|so)$/i;


/** Strip the leading `package/` (npm) or `<name>-<version>/` (cargo) component. */
export function stripArchiveRoot(path) {
  return path.replace(/^[^/]+\//, '');
}

/** Boundary violations of an archive's relative file list. `kind` is npm-wasm | npm-cli | crate. */
export function boundaryViolations(files, kind) {
  const bad = [];
  for (const file of files) {
    if (BINARY_EXT.test(file)) bad.push(`native/SDK binary: ${file}`);
    else if (SDK_PATH.test(file) || SDK_FILE.test(file)) bad.push(`SDK path: ${file}`);
    else if (/(^|\/)pkg-retained\/.*\.(js|wasm|mjs)$/.test(file)) bad.push(`retained engine asset: ${file}`);
    else if (file.endsWith('.wasm') && !(kind === 'npm-wasm' && WASM_ALLOWED.has(file))) bad.push(`unexpected wasm: ${file}`);
  }
  if (kind === 'crate') {
    for (const file of files) {
      if (file === 'build.rs') bad.push('build script present (must not fetch an SDK)');
      else if (!/^(src\/|Cargo\.toml$|Cargo\.toml\.orig$|Cargo\.lock$|README\.md$|LICENSE$|\.cargo_vcs_info\.json$)/.test(file)) {
        bad.push(`unexpected crate file: ${file}`);
      }
    }
  }
  return bad;
}

/** THIRD_PARTY_NOTICES.txt must exist and carry no `OPEN:` line. */
export function noticeProblems(text) {
  if (text === undefined || text === null) return ['THIRD_PARTY_NOTICES.txt missing'];
  const open = text.split('\n').filter((line) => /\bOPEN:/.test(line));
  return open.length ? [`${open.length} OPEN: line(s), first: ${open[0].trim().slice(0, 120)}`] : [];
}

/** The normalized crate manifest must keep a registry version and the feature forwarding. */
export function crateManifestProblems(toml) {
  const problems = [];
  const dependency = toml.match(/\[dependencies\.ifc-lite-geometry\]([\s\S]*?)(?=\n\[|$)/)?.[1] ?? '';
  if (!/version\s*=\s*"/.test(dependency)) problems.push('ifc-lite-geometry has no registry version');
  if (/\bpath\s*=/.test(dependency)) problems.push('ifc-lite-geometry carries a path');
  if (!/retained-runtime\s*=\s*\[\s*"ifc-lite-geometry\/retained-runtime"\s*\]/.test(toml)) {
    problems.push('retained-runtime feature does not forward to ifc-lite-geometry/retained-runtime');
  }
  return problems;
}

/** Every locked entry must come from a public registry: no path/git/link/file source. */
export function npmLockProblems(lock) {
  const problems = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path) continue;
    if (entry.link) problems.push(`link: ${path}`);
    else if (!entry.resolved?.startsWith(NPM_REGISTRY)) problems.push(`non-registry source: ${path} -> ${entry.resolved}`);
  }
  return problems;
}

export function cargoLockProblems(lockText, consumerName) {
  const problems = [];
  for (const block of lockText.split('[[package]]').slice(1)) {
    const name = block.match(/name = "([^"]+)"/)?.[1];
    const source = block.match(/source = "([^"]+)"/)?.[1];
    if (name === consumerName) continue;
    if (source !== 'registry+https://github.com/rust-lang/crates.io-index') problems.push(`${name}: ${source ?? 'path (no source)'}`);
  }
  return problems;
}

export function summarize(steps) {
  const count = (status) => steps.filter((s) => s.status === status).length;
  const failed = count('fail');
  return {
    status: failed ? 'fail' : count('skip') ? 'pass-with-skips' : 'pass',
    counts: { pass: count('pass'), fail: failed, skip: count('skip') },
  };
}

export function isInside(parent, child) {
  const rel = relative(realpathSync(parent), realpathSync(child));
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`));
}
