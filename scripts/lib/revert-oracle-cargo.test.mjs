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
