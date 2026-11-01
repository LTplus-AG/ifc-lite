// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import * as notices from './retained-notices.mjs';

const { renderNotices, inventoryInputs, checkNotices } = notices;
// The fixture's reused Rust std entry carries this version; the real default reads `rustc --version`.
const FIXTURE_RUSTC = 'rustc fixture';
const refreshCargoOnly = (root, metadata, readRustVersion = () => FIXTURE_RUSTC) => notices.refreshCargoOnly(root, metadata, readRustVersion);
// A manifest written by --refresh always carries a digest of its components.
const stamp = manifest => ({ manifestSha256: notices.manifestDigest(manifest), ...manifest });
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
  const nonCargo = (name, version, license = 'Apache-2.0') => ({ name, version, source: 'https://example.invalid/fixture', license, scope: 'inert fixture',
    notices: [text('LICENSE', `${name} licence text\n`)] });
  put('licenses/retained/manifest.json', JSON.stringify(stamp({ format: 2, inputs: inventoryInputs(root), components: [
    nonCargo('fixture SDK', 'b'.repeat(40)),
    nonCargo('fixture Emscripten', '4.0.15', 'MIT OR NCSA'),
    { name: 'external', version: '1.0.0', source: 'registry+https://github.com/rust-lang/crates.io-index',
      license: 'MIT OR Apache-2.0', scope: 'inert fixture',
      notices: [text('LICENSE-MIT', 'Fixture MIT licence text\n'), text('LICENSE-APACHE', 'Fixture Apache licence text\n')] },
    nonCargo('fixture Rust standard library', FIXTURE_RUSTC),
  ] })));
  checkNotices(root, false);
  const manifestPath = join(root, 'licenses/retained/manifest.json');
  return { root, put, change(path, replace) { put(path, replace(readFileSync(join(root, path), 'utf8'))); },
    manifest: () => JSON.parse(readFileSync(manifestPath, 'utf8')),
    // Edit the manifest as a hand edit or merge resolution would (digest left stale).
    editManifest(mutate) { const m = JSON.parse(readFileSync(manifestPath, 'utf8')); mutate(m); writeFileSync(manifestPath, JSON.stringify(m)); },
    // Edit and re-stamp, as if a (buggy) refresh had generated the result.
    regenerate(mutate) { const m = JSON.parse(readFileSync(manifestPath, 'utf8')); mutate(m); writeFileSync(manifestPath, JSON.stringify({ ...m, manifestSha256: notices.manifestDigest(m) })); } };
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
  f.regenerate(manifest => { manifest.components[2] = { ...manifest.components[2], notices: [] }; });
  assert.throws(() => checkNotices(f.root, false), /without preserved licence text/);
});

test('Refs #7955 deleting one text of a multi-text component fails check and --write', t => {
  const f = fixture(t);
  assert.equal(f.manifest().components[2].notices.length, 2);
  // Drop the Apache text only: the component keeps one text, so the zero-text check passes.
  f.editManifest(manifest => { manifest.components[2].notices.pop(); });
  assert.throws(() => checkNotices(f.root), /manifestSha256/);
  assert.throws(() => checkNotices(f.root, false), /manifestSha256/, '--write must not regenerate around the loss');
});

test('Refs #7955 a manifest without a components digest is refused', t => {
  const f = fixture(t);
  f.editManifest(manifest => { delete manifest.manifestSha256; });
  assert.throws(() => checkNotices(f.root), /no manifestSha256/);
  assert.throws(() => checkNotices(f.root, false), /no manifestSha256/);
});

test('Refs #7955 manifest digest ignores key order but covers inputs and components', () => {
  const m = { format: 2, inputs: { pin: 'a' }, components: [{ name: 'x', notices: [{ file: 'f', sha256: '1' }] }] };
  const digest = notices.manifestDigest(m);
  assert.equal(digest, notices.manifestDigest({ components: [{ notices: [{ sha256: '1', file: 'f' }], name: 'x' }], inputs: { pin: 'a' }, format: 2 }));
  assert.equal(digest, notices.manifestDigest({ ...m, manifestSha256: 'ignored' }));
  assert.notEqual(digest, notices.manifestDigest({ ...m, components: [{ name: 'x', notices: [] }] }));
  assert.notEqual(digest, notices.manifestDigest({ ...m, components: [{ name: 'x', notices: [{ file: 'f', sha256: '2' }] }] }));
  assert.notEqual(digest, notices.manifestDigest({ ...m, inputs: { pin: 'b' } }));
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
  refreshCargoOnly(f.root, metadata);
  checkNotices(f.root, false);
  assert.doesNotThrow(() => checkNotices(f.root));
  const after = f.manifest();
  assert.deepEqual(after.components[0], before.components[0]);
  assert.deepEqual(after.components[1], before.components[1]);
  assert.deepEqual(after.components[3], before.components[3]);
  assert.equal(after.components[2].version, '1.0.1');
  assert.equal(after.components[2].notices[0].origin, 'LICENSE-MIT');
  assert.equal(after.manifestSha256, notices.manifestDigest(after));
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
    assert.throws(() => refreshCargoOnly(f.root, metadata), new RegExp(`cargo-only refused: ${key}`), key);
    assert.equal(readFileSync(join(f.root, 'licenses/retained/manifest.json'), 'utf8'), manifest, `${key}: manifest untouched`);
  }
});

test('Refs #7955 cargo-only refresh refuses reused entries that the pins do not name', t => {
  const manifestPath = f => join(f.root, 'licenses/retained/manifest.json');
  const cases = [
    ['SDK entry from another SMLib revision', /SMLib revision/, m => { m.components[0].version = 'e'.repeat(40); }],
    ['Emscripten entry from another release', /Emscripten/, m => { m.components[1].version = '4.0.14'; }],
    ['Emscripten entry whose version only contains the pin (4.0.150)', /Emscripten/, m => { m.components[1].version = '4.0.150'; }],
    ['Rust std entry from another toolchain', /Rust standard library/, m => { m.components[3].version = 'rustc other'; }],
    ['extra reused toolchain entry', /Rust standard library/, m => { m.components.push({ ...m.components[3], name: 'extra' }); }],
  ];
  for (const [label, expected, mutate] of cases) {
    const f = fixture(t);
    const metadata = bumpExternal(f);
    f.regenerate(mutate);
    const before = readFileSync(manifestPath(f), 'utf8');
    assert.throws(() => refreshCargoOnly(f.root, metadata), expected, label);
    assert.equal(readFileSync(manifestPath(f), 'utf8'), before, `${label}: manifest untouched`);
  }
  // The committed entry is intact, but the installed toolchain is not the one it was stamped with.
  const f = fixture(t);
  const metadata = bumpExternal(f);
  assert.throws(() => refreshCargoOnly(f.root, metadata, () => 'rustc 9.9.9-nightly'), /Rust standard library/);
});

test('Refs #7955 cargo-only refresh cannot launder a damaged committed manifest', t => {
  const f = fixture(t);
  const metadata = bumpExternal(f);
  f.editManifest(manifest => { manifest.components[0].notices = []; });
  assert.throws(() => refreshCargoOnly(f.root, metadata), /manifestSha256/);
  f.editManifest(manifest => { delete manifest.manifestSha256; });
  assert.throws(() => refreshCargoOnly(f.root, metadata), /no manifestSha256/);
});

test('Refs #7955 cargo-only refresh refuses a manifest whose layout it cannot reuse', t => {
  const f = fixture(t);
  const metadata = bumpExternal(f);
  f.regenerate(manifest => { manifest.components.unshift(manifest.components.splice(2, 1)[0]); });
  assert.throws(() => refreshCargoOnly(f.root, metadata), /cargo-only refused/);
  f.regenerate(manifest => { manifest.components = manifest.components.filter(c => c.name === 'external'); });
  assert.throws(() => refreshCargoOnly(f.root, metadata), /cargo-only refused/);
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

// Hand edits to `inputs` (a merge resolution, or the obvious reaction to "inventory inputs
// changed") must not let --cargo-only keep components that no longer match the inputs.
test('Refs #7955 case A: a bumped SDK pin with hand-edited inputs cannot reuse the stale SDK text', t => {
  const pinBump = fx => {
    fx.change('native/smlib-adapter/CMakeLists.txt', text => text.replace('b'.repeat(40), 'e'.repeat(40)));
    return () => fx.editManifest(manifest => { manifest.inputs = inventoryInputs(fx.root); });
  };
  // Only the pin and `inputs` change: the components (still the old SDK) and their digest do not.
  const f = fixture(t);
  pinBump(f)();
  assert.throws(() => checkNotices(f.root), /manifestSha256/);
  assert.throws(() => checkNotices(f.root, false), /manifestSha256/);
  const h = fixture(t);
  const metadata = bumpExternal(h);
  pinBump(h)();
  assert.throws(() => refreshCargoOnly(h.root, metadata), /manifestSha256/);
  // Even with a digest regenerated over the skewed manifest, the SDK entry is not the pinned one.
  const g = fixture(t);
  g.change('native/smlib-adapter/CMakeLists.txt', text => text.replace('b'.repeat(40), 'e'.repeat(40)));
  g.regenerate(manifest => { manifest.inputs = inventoryInputs(g.root); });
  const manifest = readFileSync(join(g.root, 'licenses/retained/manifest.json'), 'utf8');
  assert.throws(() => refreshCargoOnly(g.root, () => assert.fail('metadata must not be read')), /do not carry the pinned SMLib revision/);
  assert.equal(readFileSync(join(g.root, 'licenses/retained/manifest.json'), 'utf8'), manifest);
});

// Two Cargo crates, so one can leave the Cargo block's edge while the other stays inside it.
function twoCrateFixture(t) {
  const f = fixture(t);
  for (const dir of ['wasm', 'diff']) f.change(`rust/${dir}/Cargo.toml`, text => text.replace('external="1"', 'external="1"\nzzz="1"'));
  f.change('Cargo.lock', text => `${text.replaceAll('dependencies=["external"]', 'dependencies=["external", "zzz"]')}
[[package]]
name="zzz"
version="1.0.0"
source="registry+https://github.com/rust-lang/crates.io-index"
checksum="${'f'.repeat(64)}"
`);
  const body = 'Fixture zzz licence text\n', sha256 = createHash('sha256').update(body).digest('hex');
  f.put(`licenses/retained/texts/${sha256}.txt`, body);
  f.regenerate(manifest => {
    manifest.inputs = inventoryInputs(f.root);
    manifest.components.splice(3, 0, { name: 'zzz', version: '1.0.0', source: 'registry+https://github.com/rust-lang/crates.io-index',
      license: 'MIT', scope: 'inert fixture', notices: [{ file: `texts/${sha256}.txt`, origin: 'LICENSE', sha256 }] });
  });
  checkNotices(f.root, false);
  assert.doesNotThrow(() => checkNotices(f.root));
  return f;
}

test('Refs #7955 case B: hand-edited inputs cannot demote a stale crate into a reusable non-Cargo entry', t => {
  const f = twoCrateFixture(t);
  const bumped = bumpExternal(f);
  const metadata = () => ({ packages: [...bumped().packages, { name: 'zzz', version: '1.0.0', license: 'MIT',
    source: 'registry+https://github.com/rust-lang/crates.io-index', manifest_path: join(f.root, 'crate-src/Cargo.toml') }] });
  // The obvious reaction to "inventory inputs changed": refresh only the inputs, keep the components.
  f.editManifest(manifest => { manifest.inputs = inventoryInputs(f.root); });
  assert.throws(() => checkNotices(f.root, false), /manifestSha256|Missing inventory component/);
  assert.throws(() => refreshCargoOnly(f.root, metadata), /manifestSha256/);
  // With a digest regenerated over that skew, the stale crate still may not be reused.
  f.regenerate(manifest => { manifest.inputs = inventoryInputs(f.root); });
  const before = readFileSync(join(f.root, 'licenses/retained/manifest.json'), 'utf8');
  assert.throws(() => refreshCargoOnly(f.root, metadata), /Cargo components do not match the committed inventory inputs/);
  assert.equal(readFileSync(join(f.root, 'licenses/retained/manifest.json'), 'utf8'), before);
  // The same skew from the other side: a stale extra crate sitting in the committed block.
  const g = twoCrateFixture(t);
  g.regenerate(manifest => { manifest.components.splice(3, 0, { ...manifest.components[2], version: '0.9.0' }); });
  assert.throws(() => refreshCargoOnly(g.root, () => assert.fail('metadata must not be read')), /Cargo components do not match/);
});

test('Refs #7955 cargo-only refresh applies a recorded licence election to a rebuilt Cargo component', t => {
  const f = fixture(t);
  const bumped = bumpExternal(f);
  const metadata = () => ({ packages: bumped().packages.map(pkg => ({ ...pkg, license: 'MIT OR Apache-2.0' })) });
  const apache = 'Fixture Apache licence text 1.0.1\n';
  const sha256 = createHash('sha256').update(apache).digest('hex');
  f.put(`licenses/retained/texts/${sha256}.txt`, apache);
  const notice = { origin: 'https://example.invalid/Apache-2.0.txt', file: `texts/${sha256}.txt`, sha256 };
  f.put('licenses/retained/supplemental.json', JSON.stringify([{ name: 'external', version: '1.0.1', election: 'Apache-2.0',
    attribution: 'external 1.0.1 under Apache-2.0 by election', notices: [notice] }]));
  refreshCargoOnly(f.root, metadata);
  checkNotices(f.root, false);
  assert.doesNotThrow(() => checkNotices(f.root));
  const external = f.manifest().components[2];
  assert.equal(external.election, 'Apache-2.0');
  assert.equal(external.attribution, 'external 1.0.1 under Apache-2.0 by election');
  assert.deepEqual(external.notices.map(n => n.origin), ['LICENSE-MIT', notice.origin]);
  assert.match(readFileSync(join(f.root, 'licenses/retained/THIRD_PARTY_NOTICES.txt'), 'utf8'), /Licence election: Apache-2.0/);
});

const textFiles = f => readdirSync(join(f.root, 'licenses/retained/texts')).sort();
const manifestBytes = f => readFileSync(join(f.root, 'licenses/retained/manifest.json'), 'utf8');

test('Refs #7955 cargo-only refresh writes nothing when a reused notice file is missing', t => {
  const f = fixture(t);
  const metadata = bumpExternal(f);
  rmSync(join(f.root, 'licenses/retained', f.manifest().components[0].notices[0].file));
  const manifest = manifestBytes(f), texts = textFiles(f);
  assert.throws(() => refreshCargoOnly(f.root, metadata), /ENOENT/);
  assert.equal(manifestBytes(f), manifest, 'manifest.json untouched');
  assert.deepEqual(textFiles(f), texts, 'no new text files written for the rebuilt crate');
});

test('Refs #7955 cargo-only refresh applies an election recorded for a reused component', t => {
  const f = fixture(t);
  const metadata = bumpExternal(f);
  const mit = 'Fixture Emscripten MIT text\n', sha256 = createHash('sha256').update(mit).digest('hex');
  f.put(`licenses/retained/texts/${sha256}.txt`, mit);
  const notice = { origin: 'https://example.invalid/MIT.txt', file: `texts/${sha256}.txt`, sha256 };
  const record = { name: 'fixture Emscripten', version: '4.0.15', election: 'MIT', attribution: 'fixture under MIT by election', notices: [notice] };
  f.put('licenses/retained/supplemental.json', JSON.stringify([record]));
  refreshCargoOnly(f.root, metadata);
  checkNotices(f.root, false);
  assert.doesNotThrow(() => checkNotices(f.root));
  const emscripten = f.manifest().components[1];
  assert.equal(emscripten.election, 'MIT');
  assert.equal(emscripten.attribution, record.attribution);
  assert.equal(emscripten.notices.filter(n => n.sha256 === sha256).length, 1);
  assert.match(readFileSync(join(f.root, 'licenses/retained/THIRD_PARTY_NOTICES.txt'), 'utf8'), /Licence election: MIT/);
  // Idempotent: the record is already present, so a second run changes nothing.
  const once = manifestBytes(f);
  refreshCargoOnly(f.root, metadata);
  assert.equal(manifestBytes(f), once);
  // An invalid election for a reused component is refused before anything is written.
  const g = fixture(t);
  const invalid = bumpExternal(g);
  g.put('licenses/retained/supplemental.json', JSON.stringify([{ ...record, election: 'GPL-2.0' }]));
  const untouched = manifestBytes(g);
  assert.throws(() => refreshCargoOnly(g.root, invalid), /Invalid licence election/);
  assert.equal(manifestBytes(g), untouched);
});

test('Refs #7955 check rejects an undeclared Cargo component even under a recomputed digest', t => {
  const f = fixture(t);
  f.regenerate(manifest => { manifest.components.splice(3, 0, { ...manifest.components[2], name: 'leftover', version: '0.1.0' }); });
  assert.throws(() => checkNotices(f.root), /Undeclared Cargo component: leftover 0.1.0/);
  assert.throws(() => checkNotices(f.root, false), /Undeclared Cargo component/);
});

test('Refs #7955 cargo-only refresh refuses a withdrawn or changed supplement for a reused component', t => {
  const f = fixture(t);
  const metadata = bumpExternal(f);
  const mit = 'Fixture Emscripten MIT text\n', sha256 = createHash('sha256').update(mit).digest('hex');
  f.put(`licenses/retained/texts/${sha256}.txt`, mit);
  const record = { name: 'fixture Emscripten', version: '4.0.15', election: 'MIT', attribution: 'fixture under MIT by election',
    notices: [{ origin: 'https://example.invalid/MIT.txt', file: `texts/${sha256}.txt`, sha256 }] };
  f.put('licenses/retained/supplemental.json', JSON.stringify([record]));
  refreshCargoOnly(f.root, metadata);
  checkNotices(f.root, false);
  const recorded = manifestBytes(f), texts = textFiles(f);
  f.change('Cargo.lock', text => text.replace('version="1.0.1"', 'version="1.0.2"'));
  const bumped = () => ({ packages: metadata().packages.map(pkg => ({ ...pkg, version: '1.0.2' })) });
  for (const now of [[], [{ ...record, election: 'NCSA' }]]) {
    f.put('licenses/retained/supplemental.json', JSON.stringify(now));
    assert.throws(() => refreshCargoOnly(f.root, bumped), /supplemental record for fixture Emscripten was removed or changed/);
    assert.equal(manifestBytes(f), recorded, 'manifest untouched');
    assert.deepEqual(textFiles(f), texts, 'no texts written');
  }
  // An unchanged record plus an added one is still accepted.
  const added = { name: 'external', version: '1.0.2', notices: [record.notices[0]] };
  f.put('licenses/retained/supplemental.json', JSON.stringify([record, added]));
  assert.doesNotThrow(() => refreshCargoOnly(f.root, bumped));
});

test('Refs #7955 cargo-only withdrawn-supplement guard ignores a key-only reorder of an unchanged record', t => {
  const f = fixture(t);
  const metadata = bumpExternal(f);
  const mit = 'Fixture Emscripten MIT text\n', sha256 = createHash('sha256').update(mit).digest('hex');
  f.put(`licenses/retained/texts/${sha256}.txt`, mit);
  const record = { name: 'fixture Emscripten', version: '4.0.15', election: 'MIT', attribution: 'fixture under MIT by election',
    notices: [{ origin: 'https://example.invalid/MIT.txt', file: `texts/${sha256}.txt`, sha256 }] };
  f.put('licenses/retained/supplemental.json', JSON.stringify([record]));
  refreshCargoOnly(f.root, metadata);
  f.change('Cargo.lock', text => text.replace('version="1.0.1"', 'version="1.0.2"'));
  const bumped = () => ({ packages: metadata().packages.map(pkg => ({ ...pkg, version: '1.0.2' })) });
  const reordered = { notices: [{ sha256, file: record.notices[0].file, origin: record.notices[0].origin }],
    attribution: record.attribution, election: record.election, version: record.version, name: record.name };
  f.put('licenses/retained/supplemental.json', JSON.stringify([reordered]));
  assert.doesNotThrow(() => refreshCargoOnly(f.root, bumped));
  const emscripten = f.manifest().components.find(c => c.name === 'fixture Emscripten');
  assert.equal(emscripten.notices.filter(n => n.sha256 === sha256).length, 1, 'reordered notice is not appended twice');
  checkNotices(f.root, false);
  assert.doesNotThrow(() => checkNotices(f.root));
  // The check's evidence comparison is key-order independent too, and a repeat run is a no-op.
  const once = manifestBytes(f);
  assert.doesNotThrow(() => refreshCargoOnly(f.root, bumped));
  assert.equal(manifestBytes(f), once);
});
