import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cargoTestOwner } from './revert-oracle-cargo.mjs';

test('#3974: Rust test data and source resolve to Cargo; workspace-only manifests do not', () => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-cargo-'));
  try {
    const dir = join(root, 'rust', 'geometry');
    mkdirSync(join(dir, 'tests', 'manifests'), { recursive: true });
    writeFileSync(join(root, 'Cargo.toml'), '[workspace]\nmembers = ["rust/geometry"]\n');
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "ifc-lite-geometry"\n');
    const owner = { dir, crate: 'ifc-lite-geometry' };
    assert.deepEqual(cargoTestOwner(join(dir, 'tests', 'manifests', 'census.tsv'), root), owner);
    assert.deepEqual(cargoTestOwner(join(dir, 'tests', 'census.rs'), root), owner);
    assert.equal(cargoTestOwner(join(root, 'scripts', 'gate.test.mjs'), root), null);
    assert.equal(cargoTestOwner(join(root, '..', 'outside.rs'), root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#4104: a crate excluded from the root workspace is not a cargo owner, whatever the file language', () => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-cargo-excluded-'));
  try {
    const excludedDir = join(root, 'rust', 'python');
    const memberDir = join(root, 'rust', 'geometry');
    mkdirSync(join(excludedDir, 'tests'), { recursive: true });
    mkdirSync(join(memberDir, 'tests'), { recursive: true });
    writeFileSync(
      join(root, 'Cargo.toml'),
      '[workspace]\nexclude = ["rust/python"]\nmembers = ["rust/geometry"]\n',
    );
    writeFileSync(join(excludedDir, 'Cargo.toml'), '[package]\nname = "ifc-lite-python"\n\n[workspace]\n');
    writeFileSync(join(memberDir, 'Cargo.toml'), '[package]\nname = "ifc-lite-geometry"\n');

    // The oracle cannot run `cargo test -p ifc-lite-python` from `root` (that
    // crate is excluded from the root workspace), so neither a `.py` test nor
    // a `.rs` test under it may be claimed by cargo — both must fall through
    // (to another owner, or to `unassigned`) instead of failing with
    // "package ID specification did not match any packages".
    assert.equal(cargoTestOwner(join(excludedDir, 'tests', 'test_bindings.py'), root), null);
    assert.equal(cargoTestOwner(join(excludedDir, 'tests', 'extra_test.rs'), root), null);

    // A genuine in-workspace member is unaffected.
    assert.deepEqual(cargoTestOwner(join(memberDir, 'tests', 'census.rs'), root), {
      dir: memberDir,
      crate: 'ifc-lite-geometry',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#4104 follow-up: a crate with its own [workspace] table is detached even when the root exclude list never mentions it', () => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-cargo-own-workspace-'));
  try {
    // Mirrors rust/core/fuzz, rust/geometry/fuzz, rust/csg-thread-bench: none
    // of these appear in the root manifest's `exclude`, but each declares its
    // own bare `[workspace]` table, which detaches it from the root workspace
    // exactly as `exclude` does. `cargo test -p <crate>` from `root` fails
    // with the same "package ID specification did not match any packages"
    // as an excluded crate, so cargoTestOwner must refuse to claim it too.
    const detachedDir = join(root, 'rust', 'core', 'fuzz');
    const memberDir = join(root, 'rust', 'geometry');
    mkdirSync(join(detachedDir, 'tests'), { recursive: true });
    mkdirSync(join(memberDir, 'tests'), { recursive: true });
    writeFileSync(join(root, 'Cargo.toml'), '[workspace]\nmembers = ["rust/geometry"]\n');
    writeFileSync(
      join(detachedDir, 'Cargo.toml'),
      '[package]\nname = "ifc-lite-core-fuzz"\n\n[workspace]\n',
    );
    writeFileSync(join(memberDir, 'Cargo.toml'), '[package]\nname = "ifc-lite-geometry"\n');

    assert.equal(cargoTestOwner(join(detachedDir, 'tests', 'fuzz_target.rs'), root), null);

    // A genuine in-workspace member — no [workspace] table of its own — is
    // still claimed normally. This is the regression that matters most: over-
    // detecting `[workspace]` (e.g. matching `[workspace.dependencies]`) would
    // stop real Rust tests being observed at all.
    assert.deepEqual(cargoTestOwner(join(memberDir, 'tests', 'census.rs'), root), {
      dir: memberDir,
      crate: 'ifc-lite-geometry',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#4104 follow-up: a [workspace.*] sub-table (e.g. [workspace.dependencies]) does not detach a member crate', () => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-cargo-subtable-'));
  try {
    const memberDir = join(root, 'rust', 'geometry');
    mkdirSync(join(memberDir, 'tests'), { recursive: true });
    writeFileSync(join(root, 'Cargo.toml'), '[workspace]\nmembers = ["rust/geometry"]\n');
    // A member crate manifest naming its own package can legitimately carry a
    // `[workspace.dependencies]`-shaped sub-table without being a workspace
    // root; only a bare `[workspace]` table means "own workspace root".
    writeFileSync(
      join(memberDir, 'Cargo.toml'),
      '[package]\nname = "ifc-lite-geometry"\n\n[workspace.dependencies]\nfoo = "1"\n',
    );
    assert.deepEqual(cargoTestOwner(join(memberDir, 'tests', 'census.rs'), root), {
      dir: memberDir,
      crate: 'ifc-lite-geometry',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exclude regex robustness: single-quoted TOML strings and a trailing slash both still exclude the directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-cargo-regex-'));
  try {
    const excludedDir = join(root, 'rust', 'python');
    mkdirSync(join(excludedDir, 'tests'), { recursive: true });
    writeFileSync(
      join(root, 'Cargo.toml'),
      "[workspace]\nexclude = ['rust/python/']\nmembers = []\n",
    );
    writeFileSync(join(excludedDir, 'Cargo.toml'), '[package]\nname = "ifc-lite-python"\n');
    assert.equal(cargoTestOwner(join(excludedDir, 'tests', 'extra_test.rs'), root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
