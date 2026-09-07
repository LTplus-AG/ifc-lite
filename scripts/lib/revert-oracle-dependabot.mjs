/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const NPM_MANIFEST_RE = /^(?:package\.json|(?:packages|apps|examples)\/[^/]+\/package\.json)$/;
const CARGO_MANIFESTS = new Set([
  'Cargo.toml',
  'rust/core/Cargo.toml',
  'rust/geometry/Cargo.toml',
  'rust/processing/Cargo.toml',
  'rust/clash/Cargo.toml',
  'rust/ffi/Cargo.toml',
  'rust/export/Cargo.toml',
  'rust/wasm-bindings/Cargo.toml',
  'apps/server/Cargo.toml',
]);
const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Cargo.lock']);
const DOCKERFILES = new Set([
  'apps/server/Dockerfile',
  'packages/collab-server/Dockerfile',
  'tools/ifcopenshell_reference/Dockerfile',
]);

/**
 * The normal build and test lanes are the compatibility oracle for a dependency
 * bump. Reverting its manifest without its ignored lockfile is not coherent.
 * One non-dependency path restores the normal changed-test requirement.
 */
export function isDependabotDependencyOnly(login, entries) {
  if (login !== 'dependabot[bot]' || entries.length === 0) return false;
  return entries.every(({ path }) =>
    NPM_MANIFEST_RE.test(path) || CARGO_MANIFESTS.has(path) || LOCKFILES.has(path) || DOCKERFILES.has(path)
  );
}
