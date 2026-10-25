/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { versionedIfcDeps } from './release-crate-deps.mjs';

const workspace = `
[workspace.dependencies]
ifc-lite-core = { version = "23.6.0", path = "rust/core" }
ifc-lite-path-only = { path = "rust/path-only" }
aliased = { package = "ifc-lite-from-workspace", version = "23.6.0", path = "rust/aliased" }
[workspace.dependencies.table-workspace]
package = "ifc-lite-workspace-table"
version = "23.6.0"
path = "rust/table-workspace"
`;

const manifest = `
[package]
name = "fixture"
[dependencies]
ifc-lite-direct = "23.6.0"
ifc-lite-core.workspace = true
ifc-lite-path-only.workspace = true
renamed = { package = "ifc-lite-inline-alias", version = "23.6.0", path = "../inline" }
aliased.workspace = true
table-workspace = { workspace = true }
[dev-dependencies]
ifc-lite-dev-path = { path = "../dev-path" }
[target.'cfg(not(target_arch = "wasm32"))'.dependencies]
ifc-lite-geometry-runtime = { path = "../geometry-runtime", version = "=23.6.0", optional = true }
"ifc-lite-quoted" = { version = "23.6.0", path = "../quoted" }
ifc-lite-multiline = { version = "23.6.0",
  path = "../multi" }
[target.'cfg(all(unix, target_os = "linux"))'.dev-dependencies]
ifc-lite-target-dev = { version = "23.6.0", path = "../target-dev" }
ifc-lite-target-dev-path = { path = "../target-dev-path" }
[target.x86_64-unknown-linux-gnu.build-dependencies]
ifc-lite-build.version = "23.6.0"
ifc-lite-build.path = "../build"
[target.'cfg(windows)'.build-dependencies.table-alias]
package = "ifc-lite-table-alias"
version = "23.6.0"
path = "../table"
[target.'cfg(windows)'.dev-dependencies.path-table]
package = "ifc-lite-path-table"
path = "../path-table"
[target.'cfg(windows)'.features]
ifc-lite-feature = { version = "23.6.0" }
`;

test('#7955: target normal, dev, and build dependencies preserve all versioned spellings', () => {
  assert.deepEqual(new Set(versionedIfcDeps(manifest, workspace)), new Set([
    'ifc-lite-direct', 'ifc-lite-core', 'ifc-lite-inline-alias',
    'ifc-lite-from-workspace', 'ifc-lite-workspace-table',
    'ifc-lite-geometry-runtime', 'ifc-lite-quoted', 'ifc-lite-multiline',
    'ifc-lite-target-dev', 'ifc-lite-build', 'ifc-lite-table-alias',
  ]));
});

test('#7955: stripping path-only dev dependencies does not hide versioned target edges', () => {
  const deps = versionedIfcDeps(manifest, workspace);
  assert.ok(deps.includes('ifc-lite-geometry-runtime'));
  for (const pathOnly of [
    'ifc-lite-path-only', 'ifc-lite-dev-path', 'ifc-lite-target-dev-path', 'ifc-lite-path-table',
  ]) assert.ok(!deps.includes(pathOnly), pathOnly);
  assert.ok(!deps.includes('ifc-lite-feature'));
});

test('#7955: changing a target version to path-only removes precisely that publish edge', () => {
  const pathOnly = manifest.replace('version = "=23.6.0", optional = true', 'optional = true');
  const original = new Set(versionedIfcDeps(manifest, workspace));
  const changed = new Set(versionedIfcDeps(pathOnly, workspace));
  assert.deepEqual(new Set([...original].filter((name) => !changed.has(name))), new Set(['ifc-lite-geometry-runtime']));
});

test('#7955: an unresolved workspace inheritance fails closed', () => {
  assert.throws(
    () => versionedIfcDeps('[target.\'cfg(unix)\'.dependencies]\nmissing.workspace = true', workspace),
    /Workspace dependency missing has no \[workspace.dependencies\] entry/
  );
});
