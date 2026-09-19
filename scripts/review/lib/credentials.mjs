/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CREDENTIAL SHAPE AND ORDERING (module-size budget split out of
 * run-reviewer.mjs). `checkToken` validates one credential's shape without
 * ever printing it; `resolveTokens` orders every credential this run may use.
 * Both throw `RunReviewerError`, imported from the leaf module rather than
 * from run-reviewer.mjs itself, which is what lets run-reviewer.mjs re-export
 * this file's functions without a cycle.
 */

import { RunReviewerError } from './run-reviewer-error.mjs';

/**
 * Check the credential's SHAPE without ever printing it, and hand back a trimmed
 * copy.
 *
 * A repository secret cannot be read back through the API, by design, so a
 * malformed one is invisible until it fails at run time -- and the most common
 * way to malform it is invisible in a terminal too: `echo token | gh secret set`
 * stores a TRAILING NEWLINE. That produces an auth rejection whose message says
 * nothing about whitespace, which is a long debugging session for a one-character
 * problem.
 *
 * So: trim first, so the whole whitespace class simply cannot bite, and then
 * report the shape so a genuinely wrong value says so on the first run instead of
 * looking like a quota problem. Nothing here logs the value, and the reported
 * length is a property of the credential, not the credential.
 *
 * @returns {{ token: string, note: string }}
 */
export function checkToken(raw) {
  if (raw === undefined || raw === null || String(raw) === '') {
    throw new RunReviewerError(
      'AUTH_MISSING',
      'CLAUDE_CODE_OAUTH_TOKEN is unset or empty. REMEDY: `claude setup-token`, then ' +
        '`gh secret set CLAUDE_CODE_OAUTH_TOKEN`. The lane cannot run without it, and it fails ' +
        'here rather than posting a clean verdict it never earned.',
    );
  }
  const token = String(raw).trim();
  if (token === '') {
    throw new RunReviewerError('AUTH_MALFORMED', 'CLAUDE_CODE_OAUTH_TOKEN is only whitespace.');
  }
  if (/\s/.test(token)) {
    throw new RunReviewerError(
      'AUTH_MALFORMED',
      `CLAUDE_CODE_OAUTH_TOKEN contains whitespace INSIDE it (length ${token.length}). A trailing ` +
        'newline is trimmed automatically; whitespace in the middle means the value was pasted ' +
        'wrapped or truncated. REMEDY: re-set it with `printf %s "$TOKEN" | gh secret set ...`.',
    );
  }
  const wrapped = String(raw) !== token;
  return {
    token,
    note: `credential present, ${token.length} chars${wrapped ? ' (surrounding whitespace trimmed)' : ''}`,
  };
}

/**
 * Every credential this run may use, in order, with a LABEL that is safe to
 * print. The value is never logged -- only which slot it came from -- because a
 * secret in a log is a leaked secret and this repository is public.
 */
export function resolveTokens(env) {
  const out = [];
  const seen = new Set();
  for (const [name, label] of [
    ['CLAUDE_CODE_OAUTH_TOKEN', 'the primary credential'],
    ['CLAUDE_CODE_OAUTH_TOKEN_2', 'the fallback credential'],
  ]) {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') continue;
    const { token, note } = checkToken(raw);
    // THE SAME SECRET IN BOTH SLOTS IS NOT REDUNDANCY, and it is an easy mistake
    // to make while wiring the second one up. Refused rather than retried,
    // because a fallback that shares the primary's pool fails at exactly the
    // moment it is needed while looking like insurance.
    if (seen.has(token)) {
      throw new RunReviewerError(
        'DUPLICATE_CREDENTIAL',
        `\`${name}\` holds the same value as an earlier slot. Two copies of one credential share ` +
          'one quota pool and one expiry, so this is not a fallback. REMEDY: set a token from a ' +
          'different account, or unset it.',
      );
    }
    seen.add(token);
    out.push({ token, label, note, name });
  }
  return out;
}
