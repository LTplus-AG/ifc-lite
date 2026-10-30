// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import * as notices from './retained-notices.mjs';

const { renderNotices, inventoryInputs, checkNotices } = notices;
// A manifest written by --refresh always carries a digest of its components.
const stamp = manifest => ({ componentsSha256: notices.componentsDigest(manifest.components), ...manifest });
// Namespace access: a missing election helper fails an assertion, not the module load.
const applySupplemental = (...args) => {
  assert.equal(typeof notices.applySupplemental, 'function', 'retained-notices exports applySupplemental (licence elections)');
  return notices.applySupplemental(...args);
};

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
  // Every component must preserve a licence text (absence is not compliance).
  const text = (name, body) => {
    const sha256 = createHash('sha256').update(body).digest('hex');
    put(`licenses/retained/texts/${sha256}.txt`, body);
    return { file: `texts/${sha256}.txt`, origin: name, sha256 };
  };
  const nonCargo = (name, version) => ({ name, version, source: 'fixture', license: 'Apache-2.0', scope: 'inert fixture',
    notices: [text('LICENSE', `${name} licence text\n`)] });
  put('licenses/retained/manifest.json', JSON.stringify(stamp({ format: 2, inputs: inventoryInputs(root), components: [
    nonCargo('fixture SDK', 'b'.repeat(40)),
    { name: 'external', version: '1.0.0', source: 'registry+https://github.com/rust-lang/crates.io-index',
      license: 'MIT OR Apache-2.0', scope: 'inert fixture',
      notices: [text('LICENSE-MIT', 'Fixture MIT licence text\n'), text('LICENSE-APACHE', 'Fixture Apache licence text\n')] },
    nonCargo('fixture Rust standard library', 'rustc fixture'),
  ] })));
  checkNotices(root, false);
  const manifestPath = join(root, 'licenses/retained/manifest.json');
  return { root, put, change(path, replace) { put(path, replace(readFileSync(join(root, path), 'utf8'))); },
    manifest: () => JSON.parse(readFileSync(manifestPath, 'utf8')),
    // Edit the manifest as a hand edit or merge resolution would (digest left stale).
    editManifest(mutate) { const m = JSON.parse(readFileSync(manifestPath, 'utf8')); mutate(m); writeFileSync(manifestPath, JSON.stringify(m)); },
    // Edit and re-stamp, as if a (buggy) refresh had generated the result.
    regenerate(mutate) { const m = JSON.parse(readFileSync(manifestPath, 'utf8')); mutate(m); writeFileSync(manifestPath, JSON.stringify({ ...m, componentsSha256: notices.componentsDigest(m.components) })); } };
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
  f.regenerate(manifest => { manifest.components = []; });
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
  f.regenerate(manifest => { manifest.inputs = inventoryInputs(f.root); });
  assert.throws(() => checkNotices(f.root, false), /Missing supplemental evidence/);
});

test('Refs #7955 a component without any preserved licence text fails the check', t => {
  const f = fixture(t);
  f.regenerate(manifest => { manifest.components[1] = { ...manifest.components[1], notices: [] }; });
  assert.throws(() => checkNotices(f.root, false), /without preserved licence text/);
});

test('Refs #7955 deleting one text of a multi-text component fails check and --write', t => {
  const f = fixture(t);
  assert.equal(f.manifest().components[1].notices.length, 2);
  // Drop the Apache text only: the component keeps one text, so the zero-text check passes.
  f.editManifest(manifest => { manifest.components[1].notices.pop(); });
  assert.throws(() => checkNotices(f.root), /componentsSha256/);
  assert.throws(() => checkNotices(f.root, false), /componentsSha256/, '--write must not regenerate around the loss');
});

test('Refs #7955 a manifest without a components digest is refused', t => {
  const f = fixture(t);
  f.editManifest(manifest => { delete manifest.componentsSha256; });
  assert.throws(() => checkNotices(f.root), /no componentsSha256/);
  assert.throws(() => checkNotices(f.root, false), /no componentsSha256/);
});

test('Refs #7955 components digest ignores key order but not content', () => {
  const a = [{ name: 'x', notices: [{ file: 'f', sha256: '1' }] }];
  assert.equal(notices.componentsDigest(a), notices.componentsDigest([{ notices: [{ sha256: '1', file: 'f' }], name: 'x' }]));
  assert.notEqual(notices.componentsDigest(a), notices.componentsDigest([{ name: 'x', notices: [] }]));
  assert.notEqual(notices.componentsDigest(a), notices.componentsDigest([{ name: 'x', notices: [{ file: 'f', sha256: '2' }] }]));
});

// `--refresh --cargo-only`: a Cargo.lock bump inside the closure must not need the SDK or emsdk.
function bumpExternal(f) {
  f.change('Cargo.lock', text => text.replace('version="1.0.0"', 'version="1.0.1"'));
  f.put('crate-src/Cargo.toml', '');
  f.put('crate-src/LICENSE-MIT', 'Fixture MIT licence text 1.0.1\n');
  return () => ({ packages: [{ name: 'external', version: '1.0.1', source: 'registry+https://github.com/rust-lang/crates.io-index',
    license: 'MIT', manifest_path: join(f.root, 'crate-src/Cargo.toml') }] });
}

test('Refs #7955 cargo-only refresh reuses SDK/toolchain components for a Cargo.lock bump', t => {
  const f = fixture(t);
  const before = f.manifest();
  const metadata = bumpExternal(f);
  assert.throws(() => checkNotices(f.root), /inventory inputs changed/);
  notices.refreshCargoOnly(f.root, metadata);
  checkNotices(f.root, false);
  assert.doesNotThrow(() => checkNotices(f.root));
  const after = f.manifest();
  assert.deepEqual(after.components[0], before.components[0]);
  assert.deepEqual(after.components[2], before.components[2]);
  assert.equal(after.components[1].version, '1.0.1');
  assert.equal(after.components[1].notices[0].origin, 'LICENSE-MIT');
  assert.equal(after.componentsSha256, notices.componentsDigest(after.components));
});

test('Refs #7955 cargo-only refresh fails closed when an SDK or toolchain pin changed', t => {
  for (const [key, path, replace] of [
    ['emsdkRef', '.github/workflows/geometry-platform.yml', text => text.replace('c'.repeat(40), 'd'.repeat(40))],
    ['emscriptenVersion', '.github/workflows/geometry-platform.yml', text => text.replace('install 4.0.15', 'install 4.0.16')],
    ['smlibRevision', 'native/smlib-adapter/CMakeLists.txt', text => text.replace('b'.repeat(40), 'e'.repeat(40))],
    ['rustChannel', 'rust-toolchain.toml', text => text.replace('nightly-2025-11-15', 'nightly-2025-12-01')],
  ]) {
    const f = fixture(t);
    const metadata = bumpExternal(f);
    f.change(path, replace);
    const manifest = readFileSync(join(f.root, 'licenses/retained/manifest.json'), 'utf8');
    assert.throws(() => notices.refreshCargoOnly(f.root, metadata), new RegExp(`cargo-only refused: ${key}`), key);
    assert.equal(readFileSync(join(f.root, 'licenses/retained/manifest.json'), 'utf8'), manifest, `${key}: manifest untouched`);
  }
});

test('Refs #7955 cargo-only refresh cannot launder a damaged committed manifest', t => {
  const f = fixture(t);
  const metadata = bumpExternal(f);
  f.editManifest(manifest => { manifest.components[0].notices = manifest.components[0].notices.slice(0, 0); });
  assert.throws(() => notices.refreshCargoOnly(f.root, metadata), /componentsSha256/);
  f.editManifest(manifest => { delete manifest.componentsSha256; });
  assert.throws(() => notices.refreshCargoOnly(f.root, metadata), /no componentsSha256/);
});

test('Refs #7955 cargo-only refresh refuses a manifest whose layout it cannot reuse', t => {
  const f = fixture(t);
  const metadata = bumpExternal(f);
  f.regenerate(manifest => { manifest.components.unshift(manifest.components.splice(1, 1)[0]); });
  assert.throws(() => notices.refreshCargoOnly(f.root, metadata), /cargo-only refused/);
  f.regenerate(manifest => { manifest.components = manifest.components.filter(c => c.name === 'external'); });
  assert.throws(() => notices.refreshCargoOnly(f.root, metadata), /cargo-only refused/);
});

test('Refs #7955 cargo-only flag is rejected with SDK paths or without --refresh, leaving the manifest alone', t => {
  const f = fixture(t);
  const before = readFileSync(join(f.root, 'licenses/retained/manifest.json'), 'utf8');
  for (const args of [['--refresh', '--cargo-only', '--sdk', '/nonexistent'], ['--cargo-only'], ['--write', '--cargo-only']]) {
    assert.throws(() => notices.main(args, f.root), /--cargo-only/, args.join(' '));
  }
  assert.equal(readFileSync(join(f.root, 'licenses/retained/manifest.json'), 'utf8'), before);
  // Plain --check / --write through the CLI entry still work on an intact fixture.
  assert.match(notices.main(['--check'], f.root), /match/);
  assert.match(notices.main(['--write'], f.root), /match/);
});
