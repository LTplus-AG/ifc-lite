/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import {
  EXPECTED_REPO, EXPECTED_WORKFLOW, auditProblems, binaryKind, boundaryViolations, cargoLockProblems, contentViolation,
  crateManifestProblems, isInside, isInsideResolved, noticeProblems, npmLockProblems, provenanceProblems, retainedAbsent,
  selectWheel, stripArchiveRoot, summarize,
} from './released-smoke-checks.mjs';
import { chooseToolchain, parseArgs } from './released-smoke-support.mjs';

test('archive roots are stripped', () => {
  assert.equal(stripArchiveRoot('package/pkg/a.js'), 'pkg/a.js');
  assert.equal(stripArchiveRoot('ifc-lite-geometry-runtime-27.1.0/src/lib.rs'), 'src/lib.rs');
});

test('wasm package: allowed wasm passes, retained engine, SDK and native binaries fail', () => {
  const ok = ['pkg/ifc-lite_bg.wasm', 'pkg-diff/ifc-lite-diff_bg.wasm', 'retained.js', 'pkg-retained/ifc-lite.d.ts', 'THIRD_PARTY_NOTICES.txt'];
  assert.deepEqual(boundaryViolations(ok, 'npm-wasm'), []);
  const bad = boundaryViolations(['pkg-retained/ifc-lite.js', 'pkg-retained/ifc-lite_bg.wasm', 'smlib/worker.mjs', 'bin/worker.node', 'extra.wasm'], 'npm-wasm');
  assert.equal(bad.length, 5);
});

test('cli package: its own smlib-hooks loader is not an SDK, an SDK wasm is', () => {
  assert.deepEqual(boundaryViolations(['dist/retained/smlib-hooks.js', 'dist/index.js'], 'npm-cli'), []);
  assert.equal(boundaryViolations(['dist/ifclite_smlib_browser.wasm'], 'npm-cli').length, 1);
  assert.equal(boundaryViolations(['smlib/node/worker.mjs'], 'npm-cli').length, 1);
});

test('crate archive is source only', () => {
  assert.deepEqual(boundaryViolations(['src/lib.rs', 'Cargo.toml', 'Cargo.toml.orig', 'Cargo.lock', 'README.md', 'LICENSE', '.cargo_vcs_info.json'], 'crate'), []);
  assert.equal(boundaryViolations(['build.rs', 'src/lib.rs'], 'crate').length, 1);
  assert.equal(boundaryViolations(['native/worker', 'vendor.wasm'], 'crate').length, 3);
});

test('notices: missing file and OPEN: lines fail', () => {
  assert.deepEqual(noticeProblems('all resolved\nelection: wasm_sync'), []);
  assert.match(noticeProblems(undefined)[0], /missing/);
  assert.match(noticeProblems('ok\n  OPEN: chrono election\n')[0], /1 OPEN: line/);
});

test('crate manifest needs a registry version and feature forwarding', () => {
  const good = '[features]\nretained-runtime = ["ifc-lite-geometry/retained-runtime"]\n[dependencies.ifc-lite-geometry]\nversion = "27.1.0"\n';
  assert.deepEqual(crateManifestProblems(good), []);
  assert.equal(crateManifestProblems(good.replace('version = "27.1.0"', 'path = "../geometry"')).length, 2);
  assert.equal(crateManifestProblems(good.replace('retained-runtime"]', 'other"]')).length, 1);
});

test('lock files must come from public registries', () => {
  assert.deepEqual(npmLockProblems({ packages: { '': {}, 'node_modules/a': { resolved: 'https://registry.npmjs.org/a/-/a-1.tgz' } } }), []);
  assert.equal(npmLockProblems({ packages: { 'node_modules/a': { resolved: 'file:../a' }, 'node_modules/b': { link: true } } }).length, 2);
  const registry = 'source = "registry+https://github.com/rust-lang/crates.io-index"';
  const lock = `[[package]]\nname = "smoke_consumer"\n\n[[package]]\nname = "x"\n${registry}\n\n[[package]]\nname = "y"\n`;
  assert.deepEqual(cargoLockProblems(lock, 'smoke_consumer'), ['y: path (no source)']);
});

test('summary: failures dominate, skips are explicit, never silently pass', () => {
  assert.equal(summarize([{ status: 'pass' }]).status, 'pass');
  assert.equal(summarize([{ status: 'pass' }, { status: 'skip' }]).status, 'pass-with-skips');
  const failed = summarize([{ status: 'skip' }, { status: 'fail' }]);
  assert.equal(failed.status, 'fail');
  assert.deepEqual(failed.counts, { pass: 0, fail: 1, skip: 1 });
});

test('isInside distinguishes repo from scratch', () => {
  assert.equal(isInside(process.cwd(), process.cwd()), true);
  assert.equal(isInside(process.cwd(), '/tmp'), false);
});

test('isInsideResolved is correct for win32 paths, including another drive', () => {
  const w = path.win32;
  assert.equal(isInsideResolved('C:\\repo', 'C:\\repo\\scripts', w), true);
  assert.equal(isInsideResolved('C:\\repo', 'C:\\repo', w), true);
  assert.equal(isInsideResolved('C:\\repo', 'C:\\repo2', w), false);
  assert.equal(isInsideResolved('C:\\repo', 'D:\\repo\\x', w), false);
  assert.equal(isInsideResolved('C:\\repo', 'C:\\..foo', w), false);
  assert.equal(isInsideResolved('/a/b', '/a/b/..c/d'), true, 'a directory named ..c is inside');
});

test('native binaries are detected by content, not name', () => {
  assert.equal(binaryKind(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])), 'ELF');
  assert.equal(binaryKind(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0])), 'Mach-O');
  assert.equal(binaryKind(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0])), 'Mach-O');
  const pe = Buffer.alloc(0x100); pe.write('MZ'); pe.writeUInt32LE(0x80, 0x3c); pe.write('PE\0\0', 0x80, 'latin1');
  assert.equal(binaryKind(pe), 'PE');
  assert.equal(binaryKind(Buffer.from('MZ is not a PE header and neither is this text, padded to be long enough........')), null);
  assert.equal(binaryKind(Buffer.from('plain text')), null);
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
  assert.match(contentViolation('dist/innocent.txt', elf, 'npm-cli'), /ELF binary by content/);
  const wasm = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  assert.match(contentViolation('dist/renamed.dat', wasm, 'npm-cli'), /wasm by content/);
  assert.equal(contentViolation('pkg/ifc-lite_bg.wasm', wasm, 'npm-wasm'), null);
  assert.match(contentViolation('pkg/ifc-lite_bg.wasm', wasm, 'crate'), /wasm by content/);
});

test('wheel selection matches the local CPython tag and arch', () => {
  const files = [
    'ifclite_geom-4.15.0-cp39-abi3-manylinux_2_17_aarch64.manylinux2014_aarch64.whl',
    'ifclite_geom-4.15.0-cp39-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl',
    'ifclite_geom-4.15.0-cp39-abi3-win_amd64.whl',
  ];
  assert.match(selectWheel(files, { python: [3, 12], arch: 'x86_64' }), /x86_64/);
  assert.match(selectWheel(files, { python: [3, 9], arch: 'aarch64' }), /aarch64/);
  assert.equal(selectWheel(files, { python: [3, 8], arch: 'x86_64' }), null, 'abi3 floor is 3.9');
  const exact = ['p-1-cp311-cp311-manylinux_2_17_x86_64.whl'];
  assert.equal(selectWheel(exact, { python: [3, 12], arch: 'x86_64' }), null);
  assert.equal(selectWheel(exact, { python: [3, 11], arch: 'x86_64' }), exact[0]);
});

const NAME = '@ifc-lite/wasm';
const VERSION = '12.1.0';
const DIGEST = 'ab'.repeat(64);
const INTEGRITY = `sha512-${Buffer.from(DIGEST, 'hex').toString('base64')}`;
const SAN = `URI:${EXPECTED_REPO}/${EXPECTED_WORKFLOW}@refs/heads/main`;
function attestation({ repository = EXPECTED_REPO, workflow = EXPECTED_WORKFLOW, digest = DIGEST, subject = `pkg:npm/%40ifc-lite/wasm@${VERSION}` } = {}) {
  const statement = { subject: [{ name: subject, digest: { sha512: digest } }],
    predicate: { buildDefinition: { externalParameters: { workflow: { repository, path: workflow } } } } };
  return { attestations: [
    { predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1', bundle: {} },
    { predicateType: 'https://slsa.dev/provenance/v1', bundle: {
      dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') },
      verificationMaterial: { certificate: { rawBytes: 'ignored' } } } },
  ] };
}
const check = (doc, san = SAN) => provenanceProblems(doc, { name: NAME, version: VERSION, integrity: INTEGRITY }, () => san);

test('provenance: a genuine attestation passes', () => assert.deepEqual(check(attestation()), []));

test('provenance: wrong source repository fails (fork workflow with a valid attestation)', () => {
  const fork = 'https://github.com/evil/ifc-lite';
  const problems = check(attestation({ repository: fork }), `URI:${fork}/${EXPECTED_WORKFLOW}@refs/heads/main`);
  assert.equal(problems.length, 2);
  assert.match(problems.join(' '), /sourceRepository https:\/\/github.com\/evil\/ifc-lite is not/);
  assert.match(problems.join(' '), /signing certificate identity/);
});

test('provenance: wrong workflow, wrong certificate identity, wrong digest and wrong subject fail', () => {
  assert.match(check(attestation({ workflow: '.github/workflows/other.yml' }))[0], /workflow \.github\/workflows\/other\.yml/);
  assert.match(check(attestation(), `URI:${EXPECTED_REPO}/.github/workflows/other.yml@refs/heads/main`)[0], /certificate identity/);
  assert.match(check(attestation({ digest: 'cd'.repeat(64) }))[0], /differs from the downloaded tarball/);
  assert.match(check(attestation({ subject: 'pkg:npm/%40ifc-lite/other@1.0.0' }))[0], /not this package version/);
  assert.match(provenanceProblems(attestation(), { name: NAME, version: VERSION, integrity: INTEGRITY }, () => { throw new Error('bad cert'); })[0], /unreadable/);
});

test('provenance: a missing attestation fails', () => {
  assert.match(check({ attestations: [{ predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1' }] })[0], /no SLSA provenance/);
  assert.match(check({})[0], /no SLSA provenance/);
});

test('audit: both packages must be verified with provenance and nothing invalid or missing', () => {
  const packages = [[NAME, VERSION], ['@ifc-lite/cli', '0.44.0']];
  const verified = [{ name: NAME, version: VERSION, attestations: { provenance: {} } }, { name: '@ifc-lite/cli', version: '0.44.0', attestations: { provenance: {} } }];
  assert.deepEqual(auditProblems({ invalid: [], missing: [], verified }, packages), []);
  assert.match(auditProblems({ invalid: [], missing: [], verified: verified.slice(0, 1) }, packages)[0], /cli@0\.44\.0 not in the verified list/);
  assert.match(auditProblems({ invalid: [], missing: [], verified: [verified[0], { name: '@ifc-lite/cli', version: '0.44.0' }] }, packages)[0], /without a provenance/);
  assert.equal(auditProblems({ invalid: [{}], missing: [{}], verified }, packages).length, 2);
});

test('retained probe: only the missing-engine ERR_MODULE_NOT_FOUND counts', () => {
  const message = "Cannot find module '/x/node_modules/@ifc-lite/wasm/pkg-retained/ifc-lite.js' imported from /x/retained.js";
  assert.equal(retainedAbsent({ rejected: true, code: 'ERR_MODULE_NOT_FOUND', message }), true);
  assert.equal(retainedAbsent({ rejected: true, name: 'TypeError', message: 'x is not a function' }), false);
  assert.equal(retainedAbsent({ rejected: true, code: 'ERR_MODULE_NOT_FOUND', message: "Cannot find module 'other'" }), false);
  assert.equal(retainedAbsent({ rejected: false }), false);
});

test('toolchain precedence and --strict parsing', () => {
  assert.deepEqual(chooseToolchain({ toolchain: 'a' }, '/nope', { RUSTUP_TOOLCHAIN: 'b' }), { name: 'a', source: '--toolchain' });
  assert.deepEqual(chooseToolchain({}, '/nope', { RUSTUP_TOOLCHAIN: 'b' }), { name: 'b', source: 'RUSTUP_TOOLCHAIN' });
  assert.deepEqual(chooseToolchain({}, '/nope', {}), { name: undefined, source: 'rustup default' });
  assert.equal(chooseToolchain({}, process.cwd(), {}).source, 'rust-toolchain.toml');
  assert.equal(parseArgs(['--wasm', '1', '--cli', '2', '--crate', '3', '--strict']).strict, true);
  assert.throws(() => parseArgs(['--wasm', '1', '--cli', '2']), /--crate/);
});
