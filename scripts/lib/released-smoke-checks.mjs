/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Pure archive/lock checks for scripts/smoke-released-retained.mjs (#7955). */
import { X509Certificate } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';

export const NPM_REGISTRY = 'https://registry.npmjs.org/';
const WASM_ALLOWED = new Set(['pkg/ifc-lite_bg.wasm', 'pkg-diff/ifc-lite-diff_bg.wasm']);
const BINARY_EXT = /\.(node|so|dylib|dll|exe|a|o|rlib)$/i;
const SDK_PATH = /(^|\/)(smlib|usd-brep|sdk)\//i;
const SDK_FILE = /ifclite_smlib|smlib.*\.(wasm|node|so)$/i;


/** Strip the leading `package/` (npm) or `<name>-<version>/` (cargo) component. */
export function stripArchiveRoot(path) {
  return path.replace(/^[^/]+\//, '');
}

/** Boundary violations of an archive's relative file list. `kind` is npm-wasm | npm-cli | crate. */
export function boundaryViolations(files, kind) {
  const bad = [];
  for (const file of files) {
    if (BINARY_EXT.test(file)) bad.push(`native/SDK binary: ${file}`);
    else if (SDK_PATH.test(file) || SDK_FILE.test(file)) bad.push(`SDK path: ${file}`);
    else if (/(^|\/)pkg-retained\/.*\.(js|wasm|mjs)$/.test(file)) bad.push(`retained engine asset: ${file}`);
    else if (file.endsWith('.wasm') && !(kind === 'npm-wasm' && WASM_ALLOWED.has(file))) bad.push(`unexpected wasm: ${file}`);
  }
  if (kind === 'crate') {
    for (const file of files) {
      if (file === 'build.rs') bad.push('build script present (must not fetch an SDK)');
      else if (!/^(src\/|Cargo\.toml$|Cargo\.toml\.orig$|Cargo\.lock$|README\.md$|LICENSE$|\.cargo_vcs_info\.json$)/.test(file)) {
        bad.push(`unexpected crate file: ${file}`);
      }
    }
  }
  return bad;
}

/** THIRD_PARTY_NOTICES.txt must exist and carry no `OPEN:` line. */
export function noticeProblems(text) {
  if (text === undefined || text === null) return ['THIRD_PARTY_NOTICES.txt missing'];
  const open = text.split('\n').filter((line) => /\bOPEN:/.test(line));
  return open.length ? [`${open.length} OPEN: line(s), first: ${open[0].trim().slice(0, 120)}`] : [];
}

/** The normalized crate manifest must keep a registry version and the feature forwarding. */
export function crateManifestProblems(toml) {
  const problems = [];
  const dependency = toml.match(/\[dependencies\.ifc-lite-geometry\]([\s\S]*?)(?=\n\[|$)/)?.[1] ?? '';
  if (!/version\s*=\s*"/.test(dependency)) problems.push('ifc-lite-geometry has no registry version');
  if (/\bpath\s*=/.test(dependency)) problems.push('ifc-lite-geometry carries a path');
  if (!/retained-runtime\s*=\s*\[\s*"ifc-lite-geometry\/retained-runtime"\s*\]/.test(toml)) {
    problems.push('retained-runtime feature does not forward to ifc-lite-geometry/retained-runtime');
  }
  return problems;
}

/** Every locked entry must come from a public registry: no path/git/link/file source. */
export function npmLockProblems(lock) {
  const problems = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path) continue;
    if (entry.link) problems.push(`link: ${path}`);
    else if (!entry.resolved?.startsWith(NPM_REGISTRY)) problems.push(`non-registry source: ${path} -> ${entry.resolved}`);
  }
  return problems;
}

export function cargoLockProblems(lockText, consumerName) {
  const problems = [];
  for (const block of lockText.split('[[package]]').slice(1)) {
    const name = block.match(/name = "([^"]+)"/)?.[1];
    const source = block.match(/source = "([^"]+)"/)?.[1];
    if (name === consumerName) continue;
    if (source !== 'registry+https://github.com/rust-lang/crates.io-index') problems.push(`${name}: ${source ?? 'path (no source)'}`);
  }
  return problems;
}

export function summarize(steps) {
  const count = (status) => steps.filter((s) => s.status === status).length;
  const failed = count('fail');
  return {
    status: failed ? 'fail' : count('skip') ? 'pass-with-skips' : 'pass',
    counts: { pass: count('pass'), fail: failed, skip: count('skip') },
  };
}

/** Is `child` at or below `parent`? Pure on already-resolved paths; `p` is injectable for win32 tests. */
export function isInsideResolved(parent, child, p = path) {
  const rel = p.relative(parent, child);
  if (rel === '') return true;
  // A different drive (win32) yields an absolute `rel`: that is outside, not inside.
  return !p.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${p.sep}`);
}

export function isInside(parent, child) {
  return isInsideResolved(realpathSync(parent), realpathSync(child));
}

/** Native executable/library kind by content magic (ELF, Mach-O, PE), or null. */
export function binaryKind(buffer) {
  if (buffer.length >= 4) {
    const magic = buffer.readUInt32BE(0);
    if (magic === 0x7f454c46) return 'ELF';
    // Mach-O thin (both endians) and fat/universal (0xcafebabe also prefixes Java classes: flag, none expected here).
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)) return 'Mach-O';
  }
  if (buffer.length >= 0x40 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
    const offset = buffer.readUInt32LE(0x3c);
    if (offset + 4 <= buffer.length && buffer.readUInt32BE(offset) === 0x50450000) return 'PE';
  }
  return null;
}

export const isWasm = (buffer) => buffer.length >= 4 && buffer.readUInt32BE(0) === 0x0061736d;

/** Content-based boundary check of one extracted file (independent of its name). */
export function contentViolation(file, buffer, kind) {
  const native = binaryKind(buffer);
  if (native) return `${native} binary by content: ${file}`;
  if (isWasm(buffer) && !(kind === 'npm-wasm' && WASM_ALLOWED.has(file))) return `wasm by content: ${file}`;
  return null;
}

/**
 * Pick the published wheel for this interpreter: manylinux for the local arch and
 * either an exact cpXY-cpXY match or an abi3 wheel whose floor is <= the local CPython.
 */
export function selectWheel(filenames, { python: [major, minor], arch }) {
  const local = major * 100 + minor;
  for (const name of filenames) {
    const tag = name.match(/-cp(\d)(\d+)-(cp\d+|abi3)-([^.]+(?:\.[^.]+)*)\.whl$/);
    if (!tag || !tag[4].includes('manylinux') || !tag[4].includes(arch)) continue;
    const floor = Number(tag[1]) * 100 + Number(tag[2]);
    if (tag[3] === 'abi3' ? floor <= local : floor === local) return name;
  }
  return null;
}

export const EXPECTED_REPO = 'https://github.com/LTplus-AG/ifc-lite';
export const EXPECTED_WORKFLOW = '.github/workflows/release.yml';

const defaultSan = (rawBase64) => new X509Certificate(Buffer.from(rawBase64, 'base64')).subjectAltName ?? '';

/**
 * Check a registry attestation document (`dist.attestations.url`) for one tarball:
 * an SLSA provenance statement whose subject digest is the downloaded tarball, whose
 * workflow is EXPECTED_REPO's release.yml, and whose Fulcio certificate identity (SAN)
 * is that same workflow. Signature validity is established separately (npm audit signatures).
 * `integrity` is the tarball's `sha512-<base64>`; `readSan` is injectable for tests.
 */
export function provenanceProblems(doc, { name, version, integrity }, readSan = defaultSan) {
  const slsa = (doc?.attestations ?? []).find((a) => String(a.predicateType).startsWith('https://slsa.dev/provenance/'));
  if (!slsa) return [`${name}@${version}: no SLSA provenance attestation`];
  const problems = [];
  let statement;
  try { statement = JSON.parse(Buffer.from(slsa.bundle.dsseEnvelope.payload, 'base64').toString('utf8')); } catch {
    return [`${name}@${version}: attestation payload unreadable`];
  }
  const wantDigest = Buffer.from(String(integrity).replace(/^sha512-/, ''), 'base64').toString('hex');
  const subject = (statement.subject ?? []).find((s) => s.name === `pkg:npm/${name.replace('@', '%40')}@${version}`);
  if (!subject) problems.push(`${name}@${version}: attestation subject is not this package version`);
  else if (subject.digest?.sha512 !== wantDigest) problems.push(`${name}@${version}: attested digest differs from the downloaded tarball`);
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  if (workflow?.repository !== EXPECTED_REPO) problems.push(`${name}@${version}: sourceRepository ${workflow?.repository} is not ${EXPECTED_REPO}`);
  if (workflow?.path !== EXPECTED_WORKFLOW) problems.push(`${name}@${version}: workflow ${workflow?.path} is not ${EXPECTED_WORKFLOW}`);
  let san = '';
  try { san = readSan(slsa.bundle.verificationMaterial.certificate.rawBytes); } catch { /* reported below */ }
  if (!san.includes(`URI:${EXPECTED_REPO}/${EXPECTED_WORKFLOW}@`)) problems.push(`${name}@${version}: signing certificate identity '${san || 'unreadable'}' is not ${EXPECTED_WORKFLOW} in ${EXPECTED_REPO}`);
  return problems;
}

/** `npm audit signatures --json --include-attestations` must list every package as verified with provenance and report nothing invalid or missing. */
export function auditProblems(report, packages) {
  const problems = [];
  if (report.invalid?.length) problems.push(`${report.invalid.length} invalid signature/attestation`);
  if (report.missing?.length) problems.push(`${report.missing.length} missing signature/attestation`);
  for (const [name, version] of packages) {
    const entry = (report.verified ?? []).find((v) => v.name === name && v.version === version);
    if (!entry) problems.push(`${name}@${version} not in the verified list`);
    else if (!entry.attestations?.provenance) problems.push(`${name}@${version} verified without a provenance attestation`);
  }
  return problems;
}

/** The only acceptable `loadRetainedEngine()` failure with no engine installed: the engine module is not found. */
export function retainedAbsent(probe) {
  return probe.rejected === true && probe.code === 'ERR_MODULE_NOT_FOUND' && /pkg-retained[\\/]+ifc-lite\.js/.test(probe.message ?? '');
}
