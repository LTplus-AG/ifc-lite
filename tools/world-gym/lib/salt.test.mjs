/**
 * Salt intake and containment, pinned.
 *
 * WHY THIS FILE EXISTS. Every defect this module has had was a SILENT DROP: an
 * argv shape that produced an unsalted run while the operator believed it was
 * salted. Three of them shipped past reading (`--salt=VALUE` dropped, a
 * trailing `--salt-env` returning `''`, the salt landing on an enumerable own
 * property), and each was caught by a reviewer rather than by a test, because
 * until now nothing here executed. The lane's E8 determinism check runs the
 * generator UNSALTED, so it exercises none of these paths.
 *
 * A silent drop is invisible to any check that only asserts the run finished.
 * So the assertions below are about WHY a call fails, never merely that it did:
 * a case that must be refused is asserted to throw SaltFormatError AND to name
 * the flag at fault, and every refusal is additionally asserted not to contain
 * the secret. `assert.throws` alone would pass on a typo in the module.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SaltFormatError,
  resolveSaltFromArgs,
  normalizeSalt,
  assertSecretSaltFormat,
  isSalted,
  saltFingerprint,
  deriveStreamState,
  describeSalt,
  redactSalt,
  saltEquals,
  looksLikeSaltMaterial,
} from './salt.mjs';
import { Rng } from './rng.mjs';
import { saltForSplit, REPORTING_SPLIT, SALT_ENV_VAR } from '../benchmark/splits.mjs';

/** A well-formed deployment salt: 64 lowercase hex. Test-only, never used to score. */
const SALT_A = 'a3f9c1d0e7b258461f0c9d3a5e8b7264c1d0a9f8e7b6c5d4a3f2e1d0c9b8a706';
const SALT_B = '0b1c2d3e4f5061728394a5b6c7d8e9f00112233445566778899aabbccddeeff0';

/** Run `fn`, assert it threw SaltFormatError, return the message. */
function refusal(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(
      err instanceof SaltFormatError,
      `expected SaltFormatError, got ${err?.name}: ${err?.message}`,
    );
    return err.message;
  }
  assert.fail('expected a refusal, but the call returned');
}

/** Temp dir with a mode-600 salt file, plus the dir path for cleanup. */
function saltFile(contents = SALT_A, mode = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), 'wg-salt-'));
  const path = join(dir, 'salt');
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, mode);
  return { dir, path };
}

// ---------------------------------------------------------------------------
// argv intake: the silent-drop surface
// ---------------------------------------------------------------------------

test('--salt is refused in BOTH spellings and names the two safe forms', () => {
  // Two independent conditions guard this (`a === '--salt'` and
  // `a.startsWith('--salt=')`), so exercising one leaves the other free to
  // regress. `--salt=VALUE` is the more dangerous of the two: a space-separated
  // parser drops it silently and the run proceeds UNSALTED.
  for (const args of [['--salt', SALT_A], [`--salt=${SALT_A}`]]) {
    const msg = refusal(() => resolveSaltFromArgs(args, {}));
    assert.match(msg, /--salt-env/, `${args[0]} must name the safe forms`);
    assert.match(msg, /--salt-file/);
    assert.match(msg, /rotate/, 'a value in argv is already leaked');
    assert.ok(!msg.includes(SALT_A), 'refusal must not echo the value it refused');
  }
});

test('--salt-env=VAR and --salt-file=PATH are refused, not silently dropped', () => {
  // The original bug: `=` forms parsed as nothing and the run went UNSALTED.
  for (const arg of ['--salt-env=WORLD_GYM_SALT_TEST', `--salt-file=/tmp/x`]) {
    const msg = refusal(() => resolveSaltFromArgs([arg], { WORLD_GYM_SALT_TEST: SALT_A }));
    assert.match(msg, /after a space/, `${arg} must explain the spelling`);
    assert.match(msg, /UNSALTED/, `${arg} must say what the old behaviour would have been`);
  }
});

test('a trailing salt flag throws rather than resolving to unsalted', () => {
  // The second bug: flagValue returned '' for a flag with nothing after it,
  // '' is falsy, so the run proceeded unsalted past every later check.
  for (const flag of ['--salt-env', '--salt-file']) {
    const msg = refusal(() => resolveSaltFromArgs([flag], {}));
    assert.match(msg, new RegExp(flag), 'the refusal must name the flag at fault');
    assert.match(msg, /UNSALTED/);
  }
});

test('naming two salt sources is refused in every spelling', () => {
  const { dir, path } = saltFile();
  try {
    // Both well-formed: mutually exclusive.
    assert.match(
      refusal(() => resolveSaltFromArgs(['--salt-file', path, '--salt-env', 'V'], { V: SALT_B })),
      /mutually exclusive/,
    );
    // One malformed. Must NOT become "use the other one": a typo'd duplicate
    // cannot be more permissive than the correctly-spelled duplicate.
    refusal(() => resolveSaltFromArgs(['--salt-file', path, '--salt-env'], {}));
    refusal(() => resolveSaltFromArgs(['--salt-env', 'V', '--salt-file'], { V: SALT_B }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no salt flags at all is the unsalted universe, and says so', () => {
  const salt = resolveSaltFromArgs(['--seeds', '20', '--out', 'x.json'], {});
  assert.equal(salt, '');
  assert.equal(isSalted(salt), false);
  assert.equal(saltFingerprint(salt), null);
  assert.equal(describeSalt(salt), 'unsalted');
});

test('--salt-env resolves, and an unset or salt-shaped variable is refused', () => {
  assert.equal(resolveSaltFromArgs(['--salt-env', 'V'], { V: SALT_A }), SALT_A);
  assert.match(refusal(() => resolveSaltFromArgs(['--salt-env', 'V'], {})), /not set/);
  // A pasted secret where a NAME belongs is already leaked into argv.
  const msg = refusal(() => resolveSaltFromArgs(['--salt-env', SALT_A], {}));
  assert.match(msg, /NAME of an environment variable/);
});

test('a variable that is set but blank is refused, not resolved to unsalted', () => {
  // The fourth silent drop. `normalizeSalt` maps '' and whitespace to unsalted,
  // which is correct for "no salt was asked for" and wrong once --salt-env has
  // been passed: an unset-in-CI secret or `export VAR=` would hand back the
  // PUBLIC universe while the operator believed the run was salted.
  for (const blank of ['', '   ', '\t\n']) {
    const msg = refusal(() => resolveSaltFromArgs(['--salt-env', 'V'], { V: blank }));
    assert.match(msg, /set but empty/);
    assert.match(msg, /^--salt-env V:/, 'the refusal must name the variable');
  }
});

test('the reporting split refuses a blank salt but still allows a deliberate unsalted run', () => {
  assert.equal(saltForSplit(REPORTING_SPLIT, {}), '', 'UNSET is the honest public universe');
  assert.equal(saltForSplit('training', { [SALT_ENV_VAR]: '' }), '', 'other splits are never salted');
  for (const blank of ['', '  ']) {
    const msg = refusal(() => saltForSplit(REPORTING_SPLIT, { [SALT_ENV_VAR]: blank }));
    assert.match(msg, /set but empty/);
    assert.match(msg, /PUBLIC universe/, 'the refusal must say what would otherwise be scored');
  }
  assert.equal(saltForSplit(REPORTING_SPLIT, { [SALT_ENV_VAR]: SALT_A }), SALT_A);
});

test('--salt-file enforces mode 600 and never echoes the contents', () => {
  const { dir, path } = saltFile(SALT_A, 0o644);
  try {
    const msg = refusal(() => resolveSaltFromArgs(['--salt-file', path], {}));
    assert.match(msg, /readable by group or other/);
    assert.match(msg, /chmod 600/, 'the refusal must carry the fix');
    assert.ok(!msg.includes(SALT_A), 'a refusal must never carry the file contents');
    chmodSync(path, 0o600);
    assert.equal(resolveSaltFromArgs(['--salt-file', path], {}), SALT_A);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a salt-shaped --salt-file argument that is not a path is treated as leaked', () => {
  const msg = refusal(() => resolveSaltFromArgs(['--salt-file', SALT_A], {}));
  assert.match(msg, /rotate/, 'the operator has to be told the secret is now in argv');
});

// ---------------------------------------------------------------------------
// the floor: a guessable salt is no salt
// ---------------------------------------------------------------------------

test('normalizeSalt refuses material with too little machine-generated entropy', () => {
  assert.equal(normalizeSalt(''), '');
  assert.equal(normalizeSalt(null), '');
  assert.equal(normalizeSalt(undefined), '');
  for (const weak of ['hunter2', 'correct-horse-battery-staple', 'abcabcabcabcabcabcabcabcabcabcabc']) {
    assert.match(refusal(() => normalizeSalt(weak)), /hex characters of machine-generated material/);
  }
  assert.match(refusal(() => normalizeSalt('has a space in it ' + SALT_A)), /whitespace/);
  assert.equal(normalizeSalt(`  ${SALT_A}\n`), SALT_A, 'surrounding whitespace is trimmed');
});

test('the deployment format is stricter than the floor', () => {
  // Passes the floor (64 hex inside) but is not itself 64 hex: refused for a
  // deployment, so a published exam salt cannot become a production universe.
  const prefixed = `exam-${SALT_A}`;
  assert.equal(normalizeSalt(prefixed), prefixed);
  assert.match(refusal(() => assertSecretSaltFormat(prefixed, 'TEST_SRC')), /TEST_SRC/);
  assert.equal(assertSecretSaltFormat(SALT_A, 'TEST_SRC'), SALT_A);
  assert.equal(assertSecretSaltFormat('', 'TEST_SRC'), '');
});

// ---------------------------------------------------------------------------
// containment: what may leave the process
// ---------------------------------------------------------------------------

test('the fingerprint identifies a universe without revealing it', () => {
  const fp = saltFingerprint(SALT_A);
  assert.match(fp, /^salt:[0-9a-f]{16}$/);
  assert.ok(!fp.includes(SALT_A.slice(0, 16)), 'the fingerprint must not be a prefix of the salt');
  assert.equal(fp, saltFingerprint(SALT_A), 'stable across calls');
  assert.notEqual(fp, saltFingerprint(SALT_B), 'distinct salts give distinct fingerprints');
  assert.equal(describeSalt(SALT_A), `salted ${fp}`);
});

test('redactSalt strips the secret from arbitrary text and never throws', () => {
  const text = `boom while reading ${SALT_A} at line 3`;
  const out = redactSalt(text, SALT_A);
  assert.ok(!out.includes(SALT_A));
  assert.match(out, /\[salt redacted\]/);
  // Total: unsalted, nullish and non-string inputs must not throw.
  assert.equal(redactSalt(text, ''), text);
  assert.equal(redactSalt(text, null), text);
  assert.equal(redactSalt(null, SALT_A), '');
});

test('the salt is not reachable as an own property of an Rng', () => {
  // The third bug: `this.salt` was enumerable, so JSON.stringify of any object
  // holding an Rng wrote the live secret into a log or an artifact.
  const rng = new Rng('42:corrupt', SALT_A);
  assert.equal(rng.salted, true);
  assert.ok(!Object.keys(rng).includes('salt'));
  assert.equal(rng.salt, undefined);
  const dumped = JSON.stringify({ rng, nested: [rng] });
  assert.ok(!dumped.includes(SALT_A), 'serializing an Rng must not emit the salt');
  assert.ok(!JSON.stringify(rng.fork('child')).includes(SALT_A), 'nor may a fork');
  assert.equal(rng.fork('child').salted, true, 'a fork of a salted stream stays salted');
});

// ---------------------------------------------------------------------------
// the mechanism: salted universes are unrelated
// ---------------------------------------------------------------------------

test('stream states differ per stream, per salt, and are deterministic', () => {
  const a1 = deriveStreamState(SALT_A, '42:corrupt');
  assert.deepEqual(deriveStreamState(SALT_A, '42:corrupt'), a1, 'deterministic');
  assert.notDeepEqual(deriveStreamState(SALT_A, '42:clean'), a1, 'per stream');
  assert.notDeepEqual(deriveStreamState(SALT_B, '42:corrupt'), a1, 'per salt');
  assert.equal(a1.length, 4);
  assert.ok(a1.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffffffff));
});

test('an unsalted stream is byte-identical to v1 and a salted one is not', () => {
  const draw = (salt) => {
    const r = new Rng('42:corrupt', salt);
    return Array.from({ length: 8 }, () => r.float());
  };
  const plain = draw('');
  assert.deepEqual(draw(''), plain, 'the public universe is reproducible');
  assert.notDeepEqual(draw(SALT_A), plain, 'the salted universe is a different draw');
  assert.notDeepEqual(draw(SALT_B), draw(SALT_A), 'two salts are unrelated');
});

test('saltEquals is total and refuses to treat unsalted as a match', () => {
  assert.equal(saltEquals(SALT_A, SALT_A), true);
  assert.equal(saltEquals(SALT_A, SALT_B), false);
  assert.equal(saltEquals('', ''), false, 'unsalted is not a credential');
  assert.equal(saltEquals(SALT_A, ''), false);
  assert.equal(saltEquals(`  ${SALT_A}  `, SALT_A), true, 'compared in canonical form');
});

test('looksLikeSaltMaterial answers instead of throwing', () => {
  assert.equal(looksLikeSaltMaterial(SALT_A), true);
  assert.equal(looksLikeSaltMaterial('WORLD_GYM_SALT_TEST'), false);
  assert.equal(looksLikeSaltMaterial('/tmp/some/path'), false);
  assert.equal(looksLikeSaltMaterial(undefined), false);
  assert.equal(looksLikeSaltMaterial(42), false);
});
