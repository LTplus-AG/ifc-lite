/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * THE LAST LINE BEFORE A PUBLIC LOG. `run-reviewer.mjs` captures the reviewer
 * CLI's raw stdout on `CLI_SILENT_EXIT` (there is nothing else to diagnose
 * from) and `openrouter-reviewer.mjs` captures an upstream HTTP error body
 * verbatim; both excerpts are printed to the GitHub Actions job log, which is
 * public on this repository. Neither excerpt is expected to contain a secret
 * -- the CLI is not supposed to echo its own environment, and OpenRouter is
 * not supposed to echo the Authorization header back -- but "not supposed to"
 * is exactly the gap a future CLI/provider bug lands in, and a leaked
 * `CLAUDE_CODE_OAUTH_TOKEN` or `OPENROUTER_API_KEY` in a public log is a
 * standing credential compromise until it is rotated. This is the backstop:
 * every excerpt that reaches a log or a stored field goes through here first.
 *
 * Two independent nets, because either one alone misses a class of leak:
 *
 *   1. THE VALUE NET. Every `process.env` entry whose NAME matches
 *      `/TOKEN|KEY|SECRET|PASSWORD/i` has its VALUE literal-matched and
 *      replaced, longest value first so a value that happens to be a prefix
 *      of another is not left half-redacted. This catches a secret being
 *      echoed verbatim regardless of what it looks like.
 *   2. THE SHAPE NET. `sk-ant-...` and `sk-or-...` are redacted by PATTERN
 *      even if the value is not (yet, or ever) sitting in `process.env` under
 *      this job -- a vendor error body that quotes a DIFFERENT key than the
 *      one this job holds still matches its own shape.
 *
 * Both run unconditionally; neither depends on which reason the caller is
 * classifying, because a redaction step that only fires on the suspicious
 * path is a redaction step a future refactor can route around by accident.
 */

const SECRET_ENV_NAME_RE = /TOKEN|KEY|SECRET|PASSWORD/i;
const REDACTED = '[redacted]';

/** Vendor key shapes worth matching even when the value is not in `env`. */
const SECRET_PATTERNS = [/sk-ant-[A-Za-z0-9_-]+/g, /sk-or-[A-Za-z0-9_-]+/g];

/**
 * Every env value worth treating as a secret: name matches the secret-name
 * pattern, and the value is non-trivial (a one- or two-character value is
 * never a real credential and would just mangle unrelated short substrings).
 * The floor is 3 characters, not 6: a short-but-real credential echoed by the
 * CLI is still a credential, and the old 6-char floor let a 4- or 5-character
 * secret through unredacted.
 *
 * STORED TRIMMED, with the untrimmed original ALSO stored when it differs.
 * `gh secret set` and friends store a trailing newline, so the value actually
 * sitting in `process.env` can be the credential PLUS whitespace; searching
 * only for the trimmed form would miss that exact, untrimmed text if it is
 * ever echoed verbatim (the trimmed form still catches the common case where
 * the echo itself has been trimmed).
 *
 * Sorted longest-first so a value that is a PREFIX of another value already
 * in the list is still fully covered by its own, longer replacement pass.
 */
export function collectSecretEnvValues(env = process.env) {
  const values = [];
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value !== 'string') continue;
    if (!SECRET_ENV_NAME_RE.test(name)) continue;
    const trimmed = value.trim();
    if (trimmed.length < 3) continue;
    values.push(trimmed);
    if (value !== trimmed) values.push(value);
  }
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

/**
 * Redact every occurrence of every secret-shaped env value, plus every
 * `sk-ant-`/`sk-or-` token, from `text`. Safe to call on text that has no
 * secret in it at all -- the common case -- since it is then a no-op.
 *
 * @param {unknown} text
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
export function redactSecrets(text, { env = process.env } = {}) {
  let out = String(text ?? '');
  for (const value of collectSecretEnvValues(env)) {
    out = out.split(value).join(REDACTED);
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}
