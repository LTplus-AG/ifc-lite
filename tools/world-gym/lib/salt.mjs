/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-split generation SALT for the World Gym Benchmark (B4.3).
 *
 * WHY. The benchmark's model universe is a pure function of the seed, and its
 * splits are seed arithmetic over a public range, so hosting the model bytes
 * withholds nothing: an adversary regenerates both the corrupted model and its
 * CLEAN TWIN locally and diffs them (`benchmark/attacks/clean-twin-diff.mjs`,
 * an exact 1.000 aggregate through the real scorer). The only thing that
 * changes that is a SECRET THAT ENTERS GENERATION. This module is that secret's
 * plumbing: `Rng` takes a salt, every stream in the generation path takes the
 * same salt, and without it neither the twin nor the corrupted model is
 * computable. BENCHMARK.md section 1a is normative; section 1b is the lifecycle
 * and rotation procedure.
 *
 * WHY IT IS NOT JUST A STRING CONCATENATION ONTO THE EXISTING SEED. That was
 * the obvious implementation and it does not work. The unsalted stream is
 * `mulberry32(FNV-1a(key))`: 32 bits of hashed key, 32 bits of state. Whatever
 * you concatenate into the key, the stream the generator actually consumes is
 * one of 2^32 streams, and the served bytes are a cheap oracle for testing a
 * candidate - the drawn parameters show up as dimensions in the file, and the
 * GlobalIds are a literal readout of the `guid:` stream. An attacker who never
 * learns the salt can therefore sweep 2^32 candidate stream states per seed,
 * confirm against the bytes they were served, recover the parameters, rebuild
 * the clean twin exactly and rerun the twin diff. See
 * `scripts/moonshot/b43-benchmark-salt/` for the measured cost of that sweep.
 * So the salted path is KEYED rather than hashed: HMAC-SHA256(salt, streamKey)
 * expanded into a 128-bit sfc32 state (`lib/rng.mjs`). The unsalted path is
 * left byte-for-byte alone, because the whole committed corpus depends on it.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not decide WHICH split is salted (that
 * is `benchmark/splits.mjs#saltForSplit`, and the answer is: the reporting
 * split only - dev stays open and attackable by design), and it does not
 * deliver the salt to submitters. Delivery needs the hosted scorer, which does
 * not exist; the salt is nevertheless a complete and testable mechanism without
 * it, which is what B4.3's exam measures.
 *
 * HANDLING RULES, because a salt that leaks is worse than no salt (it looks
 * like protection and is not, silently and retroactively - BENCHMARK.md 1b):
 *   - a salt NEVER enters argv. `resolveSaltFromArgs` below refuses `--salt
 *     <value>` outright and takes `--salt-env VAR` or `--salt-file PATH`.
 *   - no error, log line or artifact in this tree prints a salt value. They
 *     print `saltFingerprint()` instead, and the CLI error paths run
 *     `redactSalt()` over anything they are about to write.
 *   - a salt is VALIDATED at every boundary it crosses, because a weak salt is
 *     the same failure shape as a check that cannot fail. See `normalizeSalt`
 *     (the universal floor) and `assertSecretSaltFormat` (the deployment
 *     format).
 */

import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';

/**
 * Thrown for every rejected salt. Named so a caller can tell "the salt is
 * unacceptable" from "the file is missing" without string-matching, and so the
 * refusal is legible in a CI log.
 *
 * INVARIANT: no message constructed in this module ever contains a salt value.
 * Messages carry lengths, shapes and SOURCES (`--salt-env FOO`, a file path) -
 * never the material. An error is a log line, and a log line is a leak.
 */
export class SaltFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SaltFormatError';
  }
}

/** The documented way to mint one. Quoted in every rejection message. */
export const SALT_GEN_COMMAND =
  'node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"';

/**
 * THE FORMAT, and why it is enforced rather than documented.
 *
 * A length-only check accepts `benchmark-secret`, and a human-chosen salt is
 * defeated by the very oracle the salt exists to stop: guess, regenerate,
 * compare to the bytes you were served. The salt is the only thing between an
 * adversary and a 1.000 aggregate, so "someone configured a memorable phrase"
 * has to be a loud refusal, not a weak universe nobody notices.
 *
 * Two tiers, because the two populations are genuinely different:
 *
 * 1. UNIVERSAL FLOOR (`normalizeSalt`, applied to every salt anywhere,
 *    including the published exam salts of scripts/moonshot/b43-benchmark-salt):
 *    printable ASCII with no whitespace, and it must carry a contiguous run of
 *    at least MIN_HEX_RUN lowercase hex characters - 128 bits of
 *    machine-generated material. A human-readable label around that run is
 *    fine (`b43-exam-salt-A-<32 hex>`); a salt made only of words is not.
 * 2. DEPLOYMENT FORMAT (`assertSecretSaltFormat`, applied where a real secret
 *    enters: `saltForSplit` reading WORLD_GYM_SALT_TEST): exactly 64 lowercase
 *    hex characters, i.e. the output of SALT_GEN_COMMAND and nothing else.
 *    This is the tier that catches the specific catastrophe tier 1 cannot -
 *    someone pasting a PUBLISHED exam salt into a production scorer.
 *
 * HONEST LIMIT: this is a shape check, not an entropy oracle. It catches the
 * misconfiguration that actually happens (a memorable phrase, a repeated
 * character, a truncated paste) and cannot catch someone who deliberately types
 * 64 hex characters out of their head. The guarantee that the material is
 * random is procedural - mint it with SALT_GEN_COMMAND - and the check is what
 * makes a deviation from that procedure visible.
 */
export const MIN_HEX_RUN = 32;

/**
 * A run of hex characters carrying fewer than this many DISTINCT digits is not
 * random material (`0000...`, `dead beef` repeated). A genuinely random 32-char
 * run falls below 8 distinct with probability well under 1e-6, and a 64-char
 * one effectively never, so this rejects the mistake without rejecting the
 * documented value.
 */
const MIN_DISTINCT_HEX = 8;

/** Exactly the shape SALT_GEN_COMMAND emits: 32 CSPRNG bytes, hex-encoded. */
export const SECRET_SALT_RE = /^[0-9a-f]{64}$/;

/** Domain separation tag; changing it invalidates every existing salted split. */
const KDF_DOMAIN = 'ifc-lite-world-gym/salt/v1';

/**
 * Would this string be ACCEPTED as a salt? Used to catch a secret pasted where
 * a variable name or a path belongs - the one argv leak the refusal of `--salt`
 * does not by itself close. Total: it answers, it never throws.
 */
export function looksLikeSaltMaterial(s) {
  try {
    return normalizeSalt(s) !== '';
  } catch {
    return false;
  }
}

/** Longest contiguous lowercase-hex run in `s`, as a string. */
function longestHexRun(s) {
  let best = '';
  for (const run of s.match(/[0-9a-f]+/g) ?? []) {
    if (run.length > best.length) best = run;
  }
  return best;
}

/**
 * Canonical salt form: `''` means UNSALTED (the public, backward-compatible
 * universe). `null`/`undefined`/`''` all normalize to unsalted; anything else
 * is trimmed and validated against the universal floor described above.
 *
 * @param {string|null|undefined} salt
 * @returns {string} '' (unsalted) or the validated salt
 * @throws {SaltFormatError} never carrying the value
 */
export function normalizeSalt(salt) {
  if (salt === undefined || salt === null) return '';
  if (typeof salt !== 'string') {
    throw new SaltFormatError(`salt must be a string (got ${typeof salt})`);
  }
  const s = salt.trim();
  if (s === '') return '';
  if (!/^[\x21-\x7e]+$/.test(s)) {
    throw new SaltFormatError(
      'salt contains whitespace or non-printable characters. A salt is one line of printable ASCII; '
      + `mint one with: ${SALT_GEN_COMMAND}`,
    );
  }
  const run = longestHexRun(s);
  if (run.length < MIN_HEX_RUN || new Set(run).size < MIN_DISTINCT_HEX) {
    throw new SaltFormatError(
      `salt does not carry ${MIN_HEX_RUN} hex characters of machine-generated material `
      + `(longest lowercase-hex run: ${run.length} chars, ${new Set(run).size} distinct). `
      + 'A guessable salt is no salt - it is defeated by the offline oracle the salt exists to stop '
      + `(guess, regenerate, compare to the served bytes). Mint one with: ${SALT_GEN_COMMAND}`,
    );
  }
  return s;
}

/**
 * The DEPLOYMENT gate: a salt a real scorer runs on must be exactly 64
 * lowercase hex characters. Refuses rather than silently standing up a weak or
 * publicly-known universe.
 *
 * @param {string|null|undefined} salt
 * @param {string} source - where it came from, e.g. 'WORLD_GYM_SALT_TEST'.
 *   Named in the error so the operator knows what to fix. Never the value.
 * @returns {string} the validated salt ('' stays '')
 */
export function assertSecretSaltFormat(salt, source) {
  const s = normalizeSalt(salt);
  if (s === '') return '';
  if (!SECRET_SALT_RE.test(s)) {
    throw new SaltFormatError(
      `${source}: a deployment salt must be exactly 64 lowercase hex characters `
      + `(got ${s.length} characters). This is the format SALT_GEN_COMMAND emits, and requiring it `
      + 'is what stops a published exam salt or a hand-written phrase becoming a production universe. '
      + `Mint one with: ${SALT_GEN_COMMAND}`,
    );
  }
  return s;
}

/** True when this salt selects the salted (keyed) generation path. */
export function isSalted(salt) {
  return normalizeSalt(salt) !== '';
}

/**
 * PUBLISHABLE IDENTITY of a salt: a truncated HMAC over a fixed label, so a
 * leaderboard row can say WHICH salted universe it was scored in without
 * revealing the salt. Rotation depends on this: after a leak, rows carrying the
 * retired fingerprint are the exact set that has to be re-run or retired
 * (BENCHMARK.md section 1b).
 *
 * Returns `null` for the unsalted universe, which is itself the honest label.
 *
 * @param {string} salt
 * @returns {string|null} e.g. 'salt:9f2c1ab3d4e5f607' or null
 */
export function saltFingerprint(salt) {
  const s = normalizeSalt(salt);
  if (s === '') return null;
  const mac = createHmac('sha256', s).update(`${KDF_DOMAIN}/fingerprint`).digest('hex');
  return `salt:${mac.slice(0, 16)}`;
}

/**
 * Derive a 128-bit stream state (4 uint32 words) for one named RNG stream
 * under one salt. The salt is the HMAC KEY, so the streams of two different
 * salts are unrelated and no amount of observing one salted universe says
 * anything about another.
 *
 * @param {string} salt - a normalized, non-empty salt
 * @param {string|number} streamKey - the public stream name, e.g. '42:corrupt'
 * @returns {[number, number, number, number]}
 */
export function deriveStreamState(salt, streamKey) {
  const digest = createHmac('sha256', salt).update(`${KDF_DOMAIN}/stream/${streamKey}`).digest();
  return [
    digest.readUInt32LE(0),
    digest.readUInt32LE(4),
    digest.readUInt32LE(8),
    digest.readUInt32LE(12),
  ];
}

/**
 * Human-readable universe label for a log line. Prints the FINGERPRINT, never
 * the salt, so a CI transcript can say which universe a run belongs to without
 * becoming a rotation event.
 */
export function describeSalt(salt) {
  const id = saltFingerprint(salt);
  return id === null ? 'unsalted' : `salted ${id}`;
}

/**
 * Last-line defence for anything about to be written to a stream: strip a known
 * salt out of it. Every CLI in this tree runs its fatal-error text through this
 * before printing, so that even a message built somewhere else - a stack frame,
 * a third-party throw that happened to capture an argument - cannot carry the
 * secret out. Deliberately dumb and total: no regex, no parsing, no throwing.
 */
export function redactSalt(text, salt) {
  const s = typeof salt === 'string' ? salt.trim() : '';
  const out = String(text ?? '');
  return s === '' ? out : out.split(s).join('[salt redacted]');
}

/**
 * Read a salt from a file. The contents are read once, never echoed, and never
 * placed in an error message - every failure names the PATH only.
 *
 * The mode check is not fastidiousness. A salt file another user on the box can
 * read is the same leak as a salt in `ps`, just quieter, so it is a refusal
 * with the fix in the message rather than a warning nobody reads.
 */
function readSaltFile(path) {
  let st;
  try {
    st = statSync(path);
  } catch (err) {
    throw new SaltFormatError(`--salt-file ${path}: cannot stat it (${err.code ?? 'unknown error'})`);
  }
  if (!st.isFile()) {
    throw new SaltFormatError(`--salt-file ${path}: not a regular file`);
  }
  if ((st.mode & 0o077) !== 0) {
    throw new SaltFormatError(
      `--salt-file ${path}: mode ${(st.mode & 0o777).toString(8)} is readable by group or other. `
      + 'A salt readable by another user on this machine is a leak (BENCHMARK.md section 1b). '
      + `Run: chmod 600 ${path}`,
    );
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new SaltFormatError(`--salt-file ${path}: cannot read it (${err.code ?? 'unknown error'})`);
  }
  try {
    return normalizeSalt(raw);
  } catch (err) {
    // Re-thrown with the source attached, still without the contents.
    throw new SaltFormatError(`--salt-file ${path}: ${err.message}`);
  }
}

/**
 * THE ONE WAY A CLI IN THIS TREE TAKES A SALT.
 *
 * `--salt <value>` IS REFUSED. Not deprecated, not warned about - refused, with
 * a non-zero exit. A value in argv is visible in `ps`, in
 * `/proc/<pid>/cmdline`, in the invoking shell's history file and in the
 * command echo of every CI runner, i.e. to every other user on the box and to
 * anything that scrapes a process table. There is no way to pass a secret in
 * argv safely, so the flag cannot be "made safe" and is not kept working; what
 * it does instead is fail loudly and name the two forms that are safe. Silently
 * ignoring it would be worse than either: the caller would get an UNSALTED run
 * believing it was salted, which is precisely the failure this whole mechanism
 * is about.
 *
 *   --salt-env VAR    read the salt from environment variable VAR
 *   --salt-file PATH  read it from PATH (mode 600, contents never echoed)
 *
 * Neither form applies the DEPLOYMENT format (`assertSecretSaltFormat`), only
 * the universal floor: these CLIs are local instruments, and one of the things
 * they must be able to do is reproduce the B4.3 exam under its published,
 * deliberately-not-production-format salts. The deployment format is enforced
 * where a deployment salt actually enters scoring - `splits.mjs#saltForSplit`.
 *
 * @param {string[]} args - argv slice
 * @param {Record<string, string|undefined>} [env]
 * @returns {string} '' (unsalted) or the validated salt
 */
export function resolveSaltFromArgs(args, env = process.env) {
  const flagValue = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  // `--salt VALUE` AND `--salt=VALUE`. The second spelling matters more than it
  // looks: this repo's flag parser is space-separated, so an unrecognised
  // `--salt=...` would be silently dropped and the run would proceed UNSALTED
  // while the caller believed otherwise - the worst of the three outcomes.
  if (args.some((a) => a === '--salt' || a.startsWith('--salt='))) {
    throw new SaltFormatError(
      '--salt is refused: a salt passed as a command-line argument is visible in `ps`, in '
      + '/proc/<pid>/cmdline, in your shell history and in CI logs, and a leaked salt retroactively '
      + 'invalidates every row scored under it (BENCHMARK.md section 1b). '
      + 'Use --salt-env <VAR> or --salt-file <PATH> instead, and treat the value you just passed as '
      + 'leaked: rotate it.',
    );
  }
  // Same trap for the safe flags: `--salt-env=FOO` would parse as nothing.
  for (const a of args) {
    if (a.startsWith('--salt-env=') || a.startsWith('--salt-file=')) {
      throw new SaltFormatError(`${a.slice(0, a.indexOf('='))} takes its argument after a space, not an "=" (this parser would have ignored it and run UNSALTED)`);
    }
  }

  const envVar = flagValue('--salt-env');
  const filePath = flagValue('--salt-file');
  if (envVar !== undefined && filePath !== undefined) {
    throw new SaltFormatError('--salt-env and --salt-file are mutually exclusive');
  }

  if (envVar !== undefined) {
    if (envVar === '' || envVar.startsWith('-')) {
      throw new SaltFormatError('--salt-env takes the NAME of an environment variable, e.g. --salt-env WORLD_GYM_SALT_TEST');
    }
    const value = env[envVar];
    if (value === undefined) {
      // RESOLUTION FAILED. If what was passed is salt-SHAPED, this is a secret
      // pasted where a name belongs - already in argv and in the shell history
      // - so say that, and do NOT echo it while saying it. A hex salt is a
      // perfectly valid identifier, so nothing but shape can separate the two;
      // and existence is checked first so a real variable name that happens to
      // look hex-ish still resolves normally.
      if (looksLikeSaltMaterial(envVar)) {
        throw new SaltFormatError(
          '--salt-env takes the NAME of an environment variable, not its value, and what you passed '
          + 'looks like salt material. It is now in this process\'s argv and in your shell history: '
          + 'treat it as leaked and rotate it (BENCHMARK.md section 1b).',
        );
      }
      throw new SaltFormatError(`--salt-env ${envVar}: environment variable is not set`);
    }
    try {
      return normalizeSalt(value);
    } catch (err) {
      throw new SaltFormatError(`--salt-env ${envVar}: ${err.message}`);
    }
  }

  if (filePath !== undefined) {
    if (filePath === '') throw new SaltFormatError('--salt-file takes a path');
    // Same rule, same order: a path that EXISTS is a path, whatever it looks
    // like (scratch directories are full of hex). Only a non-existent argument
    // that is salt-shaped is a pasted secret.
    if (!existsSync(filePath) && looksLikeSaltMaterial(filePath)) {
      throw new SaltFormatError(
        '--salt-file takes a PATH, and what you passed is not one and looks like salt material. '
        + 'It is now in this process\'s argv and in your shell history: treat it as leaked and rotate it.',
      );
    }
    return readSaltFile(filePath);
  }

  return '';
}

/**
 * Constant-time comparison of a presented salt against the expected one, for
 * any future code path that accepts a salt from a request. Returns false for
 * the unsalted universe on either side rather than treating '' as a match.
 */
export function saltEquals(a, b) {
  const x = normalizeSalt(a);
  const y = normalizeSalt(b);
  if (x === '' || y === '') return false;
  const bx = Buffer.from(createHash('sha256').update(x).digest());
  const by = Buffer.from(createHash('sha256').update(y).digest());
  return timingSafeEqual(bx, by);
}
