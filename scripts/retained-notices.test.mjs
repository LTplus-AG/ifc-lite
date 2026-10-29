// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { renderNotices, inventoryInputs, checkNotices, applySupplemental } from './retained-notices.mjs';

test('Refs #7955 notice bundle preserves attribution bytes and refuses corrupted inputs', () => {
  const text = 'Copyright Example Author\nPermission and disclaimer\n';
  const component = { name: 'fixture', version: '1', license: 'MIT', source: 'fixture archive', scope: 'inert packaging fixture',
    notices: [{ file: 'fixture.txt', origin: 'LICENSE', sha256: createHash('sha256').update(text).digest('hex') }] };
  assert.ok(renderNotices({ components: [component] }, () => text).includes(text));
  assert.throws(() => renderNotices({ components: [component] }, () => 'truncated'), /hash mismatch/);
  assert.match(renderNotices({ components: [{ ...component, notices: [] }] }, () => ''), /OPEN: upstream package contains no licence text/);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'notice-inputs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  put('Cargo.toml', '[workspace]\n[workspace.package]\nversion="0.1.0"\n');
  for (const [dir, name] of [['wasm', 'ifc-lite-wasm'], ['diff', 'ifc-lite-diff-wasm']]) {
    put(`rust/${dir}/Cargo.toml`, `[package]\nname="${name}"\nversion.workspace=true\n[dependencies]\nexternal="1"\n`);
  }
  put('Cargo.lock', `version=4\n${['ifc-lite-wasm', 'ifc-lite-diff-wasm'].map(name =>
    `[[package]]\nname="${name}"\nversion="0.1.0"\ndependencies=["external"]\n`).join('')}
[[package]]
name="external"
version="1.0.0"
source="registry+https://github.com/rust-lang/crates.io-index"
checksum="${'a'.repeat(64)}"
`);
  put('rust-toolchain.toml', '[toolchain]\nchannel="nightly-2025-11-15"\n');
  put('native/smlib-adapter/CMakeLists.txt', `set(IFCLITE_SMLIB_REVISION ${'b'.repeat(40)})\n`);
  put('.github/workflows/geometry-platform.yml', `repository: emscripten-core/emsdk\nref: ${'c'.repeat(40)}\nrun: emsdk/emsdk install 4.0.15\n`);
  put('licenses/retained/supplemental.json', '[]');
  for (const dir of ['packages/cli', 'packages/wasm']) mkdirSync(join(root, dir), { recursive: true });
  put('licenses/retained/manifest.json', JSON.stringify({ inputs: inventoryInputs(root), components: [{
    name: 'external', version: '1.0.0', source: 'registry+https://github.com/rust-lang/crates.io-index',
    license: 'MIT', scope: 'inert fixture', notices: [],
  }] }));
  checkNotices(root, false);
  return { root, change(path, replace) { put(path, replace(readFileSync(join(root, path), 'utf8'))); } };
}

test('Refs #7955 notice check accepts a pure workspace version bump', t => {
  const f = fixture(t);
  for (const path of ['Cargo.toml', 'Cargo.lock']) f.change(path, text => text.replaceAll('0.1.0', '0.2.0'));
  assert.doesNotThrow(() => checkNotices(f.root));
});

test('Refs #7955 notice check accepts unrelated workflow edits', t => {
  const f = fixture(t);
  f.change('.github/workflows/geometry-platform.yml', text => `${text}\n# change job description\nname: Friendly job name\n`);
  assert.doesNotThrow(() => checkNotices(f.root));
});

test('Refs #7955 notice check rejects an external dependency version or checksum change', t => {
  const f = fixture(t);
  f.change('Cargo.lock', text => text.replace('version="1.0.0"', 'version="1.0.1"'));
  assert.throws(() => checkNotices(f.root), /inventory inputs changed/);
  f.change('Cargo.lock', text => text.replace('version="1.0.1"', 'version="1.0.0"').replace('a'.repeat(64), 'd'.repeat(64)));
  assert.throws(() => checkNotices(f.root), /inventory inputs changed/);
});

test('Refs #7955 diff-only dependency is bound to its own closure', t => {
  const f = fixture(t);
  f.change('rust/wasm/Cargo.toml', text => text.replace('[dependencies]', '[dev-dependencies]'));
  const inputs = inventoryInputs(f.root);
  assert.deepEqual(inputs.cargoClosures['ifc-lite-wasm'], []);
  assert.equal(inputs.cargoClosures['ifc-lite-diff-wasm'][0].name, 'external');
  assert.throws(() => checkNotices(f.root), /inventory inputs changed/);
});

test('Refs #7955 notice check discovers a new locked production dependency', t => {
  const f = fixture(t);
  f.change('Cargo.lock', text => `${text}\n[[package]]\nname="added"\nversion="1.0.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"\nchecksum="${'e'.repeat(64)}"\n`);
  assert.doesNotThrow(() => checkNotices(f.root), 'unreachable lock entries are irrelevant');
  f.change('Cargo.lock', text => text.replaceAll('dependencies=["external"]', 'dependencies=["external", "added"]'));
  f.change('rust/diff/Cargo.toml', text => `${text}added="1"\n`);
  assert.throws(() => checkNotices(f.root), /inventory inputs changed/);
});

test('Refs #7955 changing the emsdk pin requires notice review', t => {
  const f = fixture(t);
  f.change('.github/workflows/geometry-platform.yml', text => text.replace('c'.repeat(40), 'd'.repeat(40)));
  assert.throws(() => checkNotices(f.root), /inventory inputs changed/);
});

test('Refs #7955 removing a declared closure component cannot be hidden by regenerating outputs', t => {
  const f = fixture(t);
  f.change('licenses/retained/manifest.json', text => JSON.stringify({ ...JSON.parse(text), components: [] }));
  assert.throws(() => checkNotices(f.root, false), /Missing inventory component: external/);
});

// Refs #7955: an OR election preserves the declaration and supplies an identified text.
test('Refs #7955 Apache election renders attribution and preserves the licence text', () => {
  const text = 'Apache licence fixture\n';
  const component = { name: 'wasm_sync', version: '0.1.2', license: 'MIT OR Apache-2.0',
    source: 'crates.io', scope: 'fixture', notices: [] };
  const supplement = { name: component.name, version: component.version, election: 'Apache-2.0',
    attribution: 'wasm_sync 0.1.2 (crates.io), licensed under Apache-2.0 by election from MIT OR Apache-2.0',
    notices: [{ file: 'apache.txt', origin: 'SPDX fixture', sha256: createHash('sha256').update(text).digest('hex') }] };
  applySupplemental([component], [supplement]);
  const rendered = renderNotices({ components: [component] }, () => text);
  assert.match(rendered, /Licence declaration: MIT OR Apache-2.0/);
  assert.match(rendered, /Licence election: Apache-2.0/);
  assert.ok(rendered.includes(supplement.attribution));
  assert.ok(rendered.includes(text));
  assert.doesNotMatch(rendered, /OPEN:/);
  for (const license of ['MIT', 'MIT AND Apache-2.0', '(MIT OR Apache-2.0)']) {
    assert.throws(() => applySupplemental([{ ...component, license, notices: [] }], [supplement]), /Invalid licence election/);
  }
  assert.throws(() => applySupplemental([component], [{ ...supplement, election: 'BSD-3-Clause' }]), /Invalid licence election/);
  assert.throws(() => applySupplemental([component], [{ ...supplement, notices: [] }]), /Invalid licence election/);
  assert.throws(() => applySupplemental([], [supplement]), /Stale supplemental notice/);
});

test('Refs #7955 notice check refuses omitted election evidence even after output regeneration', t => {
  const f = fixture(t);
  const supplement = { name: 'external', version: '1.0.0', election: 'Apache-2.0',
    attribution: 'external by election', notices: [] };
  f.change('licenses/retained/supplemental.json', () => JSON.stringify([supplement]));
  f.change('licenses/retained/manifest.json', text => {
    const manifest = JSON.parse(text);
    manifest.inputs = inventoryInputs(f.root);
    return JSON.stringify(manifest);
  });
  assert.throws(() => checkNotices(f.root, false), /Missing supplemental evidence/);
});
