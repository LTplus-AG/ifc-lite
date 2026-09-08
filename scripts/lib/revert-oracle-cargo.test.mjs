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
