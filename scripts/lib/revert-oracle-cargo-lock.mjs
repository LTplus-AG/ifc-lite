/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const isCargoManifest = (path) => /(^|\/)Cargo\.toml$/.test(path);

/**
 * Cargo.lock is one workspace-wide resolution. Reverting it is safe only when
 * every changed manifest that contributed to that resolution is reverted with
 * it. Otherwise a test-time Cargo invocation can rewrite the mixed base/head
 * lockfile and prevent the forward restoration patch from applying (#4592).
 */
export function partialCargoManifestSelection(cargoLockChanged, productionPaths, selectedPaths) {
  if (!cargoLockChanged) return null;
  const changed = productionPaths.filter(isCargoManifest);
  const selected = selectedPaths.filter(isCargoManifest);
  if (selected.length === 0 || selected.length === changed.length) return null;
  return changed.map((path) => `${selectedPaths.includes(path) ? 'selected' : 'missing'}: ${path}`);
}

export function cargoLockPatchPaths(cargoLockChanged, selectedPaths) {
  return cargoLockChanged && selectedPaths.some(isCargoManifest)
    ? [...selectedPaths, 'Cargo.lock']
    : selectedPaths;
}

/** Re-materialize restored tracked paths through Git's checkout filters. */
export function normalizeRestoredPaths(rawGit, headSha, paths) {
  const tracked = paths.filter((path) => rawGit(['cat-file', '-e', `${headSha}:${path}`]).status === 0);
  if (tracked.length === 0) return null;
  for (const path of tracked) {
    const expected = rawGit(['rev-parse', `${headSha}:${path}`]);
    const actual = rawGit(['hash-object', '--path', path, path]);
    if (expected.status !== 0 || actual.status !== 0 || expected.stdout.trim() !== actual.stdout.trim()) {
      return `substantive post-test change preserved: ${path}`;
    }
  }
  const result = rawGit(['-c', 'core.autocrlf=false', 'checkout', headSha, '--', ...tracked]);
  if (!result.error && result.status === 0) return null;
  return result.error?.message ?? (result.stderr || '').trim();
}
