/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Base class for every error this package throws. Messages here are held to
 * the same bar as the rest of this module: never interpolate a token, an
 * authorization code, a PKCE verifier, or a raw provider response body — see
 * the per-throw comments in `token-exchange.ts` and `authorization.ts` for
 * why each specific message is safe.
 */
export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthError';
  }
}

/**
 * RFC 6749 §4.1.2.1's NQCHAR production — the character set the `error` and
 * `error_description` parameters are *defined* over: `%x20-21 / %x23-5B /
 * %x5D-7E`. That is printable ASCII minus `"` and `\`, and it excludes every
 * control character, including newline and the ESC that starts an ANSI escape
 * sequence.
 */
const NQCHAR_PATTERN = /[^\x20-\x21\x23-\x5B\x5D-\x7E]/g;
const ERROR_CODE_MAX_LENGTH = 64;
const ERROR_DESCRIPTION_MAX_LENGTH = 200;

/**
 * Makes provider-supplied `error`/`error_description` text safe to interpolate
 * into an error message.
 *
 * Both fields are attacker-reachable without any prior authentication check.
 * `parseAuthorizationCallback` handles them *before* it compares `state` —
 * deliberately, so a genuine provider error is reported as itself rather than
 * as a CSRF mismatch — which means anyone who can cause a navigation to the
 * redirect URI chooses their contents, with no valid `state` required; on the
 * token-exchange side they come out of a response body. Neither is bounded in
 * length or restricted in character set by anything upstream of this package.
 *
 * The resulting message is not "just a string": it lands in browser consoles,
 * terminal output, log aggregators and pasted bug reports. Unbounded length
 * makes those unreadable (or expensive); newlines let one field forge what
 * looks like additional, independent log lines; ESC lets it rewrite a
 * terminal's output, including hyperlinks that point somewhere else entirely.
 *
 * So: characters outside NQCHAR are dropped rather than escaped (there is no
 * legitimate value that needs them — they are outside the field's own
 * grammar), and the result is truncated to `maxLength`, marked so a reader
 * can tell truncation from a short value.
 */
function sanitizeProviderText(raw: string, maxLength: number): string {
  const stripped = raw.replace(NQCHAR_PATTERN, '');
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength)} (truncated)` : stripped;
}

/**
 * An `error` code is a single token from a fixed grammar, so unlike a free-text
 * description it can be validated rather than merely cleaned: a value that is
 * not entirely NQCHAR, is empty, or is longer than any real error code is not
 * a code that was truncated — it is not a code at all, and interpolating a
 * cleaned-up version of it would present attacker-chosen text as if the
 * authorization server had named it. Report the shape violation instead.
 */
export function sanitizeErrorCode(raw: string): string {
  const stripped = raw.replace(NQCHAR_PATTERN, '');
  if (stripped.length === 0 || stripped.length !== raw.length || raw.length > ERROR_CODE_MAX_LENGTH) {
    return '(malformed error code)';
  }
  return stripped;
}

/** Free-text, so cleaned and capped rather than rejected outright. */
export function sanitizeErrorDescription(raw: string): string {
  return sanitizeProviderText(raw, ERROR_DESCRIPTION_MAX_LENGTH);
}

/** The `state` returned on the redirect didn't match the one this session
 *  generated — either a forged/replayed callback, or a stale tab. Per RFC
 *  6749 §10.12, `state` exists specifically to bind the callback to the
 *  request that started it and stop cross-site request forgery. */
export class OAuthStateMismatchError extends OAuthError {
  constructor() {
    super('authorization callback "state" does not match the request that started it (possible CSRF or a stale tab)');
    this.name = 'OAuthStateMismatchError';
  }
}

/** The redirect landed with an origin other than the one this flow expects. */
export class OAuthRedirectOriginError extends OAuthError {
  constructor(expectedOrigin: string) {
    super(`authorization callback origin does not match the expected redirect origin (${expectedOrigin})`);
    this.name = 'OAuthRedirectOriginError';
  }
}

/** The authorization server sent back an `error` parameter instead of a code.
 *
 *  `errorCode` and the description are provider-supplied text that reaches
 *  this constructor before any `state` check has passed, so both are put
 *  through `sanitizeErrorCode`/`sanitizeErrorDescription` above. `errorCode`
 *  exposes the *sanitized* value, not the raw one: it is a public readonly
 *  field callers are expected to branch and display on, so handing them the
 *  unfiltered string would just move the same problem one call frame out. */
export class OAuthAuthorizationError extends OAuthError {
  readonly errorCode: string;

  constructor(errorCode: string, description?: string) {
    const safeCode = sanitizeErrorCode(errorCode);
    const safeDescription = description === undefined ? undefined : sanitizeErrorDescription(description);
    super(`authorization server returned "${safeCode}"${safeDescription ? `: ${safeDescription}` : ''}`);
    this.errorCode = safeCode;
    this.name = 'OAuthAuthorizationError';
  }
}

/** The token endpoint rejected a code/refresh-token exchange, or its response
 *  didn't have the shape a token response must have. */
export class TokenExchangeError extends OAuthError {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'TokenExchangeError';
  }
}

/** `getValidAccessToken` was called with no stored session, or with a stored
 *  session whose access token expired and which has no refresh token. */
export class NotSignedInError extends OAuthError {
  constructor(message = 'not signed in') {
    super(message);
    this.name = 'NotSignedInError';
  }
}
