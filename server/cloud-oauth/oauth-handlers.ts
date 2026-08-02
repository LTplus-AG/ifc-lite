/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generic request handlers for the four OAuth routes, built on the pure helpers
 * in `oauth-core.ts` and parameterised by an `OAuthProviderSpec`. Every cloud
 * provider reuses these — only the spec (endpoints, scopes, id) differs.
 *
 *   GET  /api/<id>/auth-start     → redirect to the provider consent screen
 *   GET  /api/<id>/auth-callback  → exchange code, set refresh cookie, close popup
 *   POST /api/<id>/token          → mint a short-lived access token from the cookie
 *   POST /api/<id>/disconnect     → clear the refresh cookie
 *
 * Each handler is a `(Request) => Promise<Response>` so it works in both the
 * Vercel edge runtime and the local node dev server, and is directly testable.
 */

import {
  type OAuthClientConfig,
  type OAuthProviderSpec,
  OAuthTokenError,
  buildAuthorizeUrl,
  cookiePath,
  exchangeCodeForTokens,
  parseCookies,
  randomState,
  redirectUriFor,
  refreshAccessToken,
  refreshCookieName,
  serializeCookie,
  stateCookieName,
} from './oauth-core.js';

/** Same-origin localStorage key the popup writes to signal the opener. */
export const AUTH_RESULT_STORAGE_KEY = 'ifc-lite:cloud:auth-result';

export interface OAuthHandlerDeps {
  spec: OAuthProviderSpec;
  config: OAuthClientConfig;
  fetchImpl?: typeof fetch;
  /** Override for tests; defaults to `randomState()`. */
  makeState?: () => string;
}

export interface OAuthHandlers {
  authStart: (req: Request) => Promise<Response>;
  authCallback: (req: Request) => Promise<Response>;
  token: (req: Request) => Promise<Response>;
  disconnect: (req: Request) => Promise<Response>;
}

const REFRESH_MAX_AGE = 60 * 60 * 24 * 365; // ~1 year
const STATE_MAX_AGE = 60 * 10; // 10 minutes to complete consent

function json(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * `token` and `disconnect` are POST-only, cookie-authenticated mutations —
 * `token` mints an access token from the refresh cookie, `disconnect` clears
 * it. Both cookies are `SameSite=Lax`, which IS sent on a top-level GET
 * navigation, so without a method check an attacker page can link/redirect a
 * signed-in user to either route: to `disconnect` (forced logout — a
 * nuisance, not data exposure, since nothing is read or leaked) or, worse, to
 * `token`, which would mint and return a real access token into that GET
 * response. Requiring POST closes both.
 */
function methodNotAllowed(): Response {
  return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
}

/**
 * Second, best-effort layer on top of the method check: when the browser
 * sends an `Origin` header (it does on cross-site POSTs, including the ones a
 * CSRF form/fetch from another page would send), it must match this route's
 * own origin. These routes are strictly same-origin — unlike `chat-handler.ts`,
 * which deliberately serves a cross-origin-embeddable widget behind an
 * allow-list, nothing here is ever meant to be called from another site, so
 * there is no allow-list to consult. A request with no `Origin` header at all
 * (e.g. a same-origin form post in some browsers) is not rejected on that
 * basis alone — the method check plus `SameSite=Lax` already cover most of
 * the real risk; this only adds a check when the signal is actually present.
 */
function isSameOriginRequest(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(req.url).origin;
  } catch {
    return false;
  }
}

function originRejected(): Response {
  return json({ error: 'origin_not_allowed' }, 403);
}

/**
 * Reduce a status message to a short, safe code. Provider error values are
 * attacker-controlled (e.g. `?error=…` on the callback), so we whitelist to a
 * harmless character set before it ever reaches the HTML/JS below — defence in
 * depth on top of the escaping.
 */
function sanitizeMessage(message: string): string {
  return message.replace(/[^a-zA-Z0-9 ._:-]/g, '').slice(0, 200);
}

/**
 * Embed a JSON string as a `<script>`-safe JS string literal. Escaping
 * `<`/`>` prevents a `</script>` break-out; line/paragraph separators cannot
 * reach here because `sanitizeMessage` already strips them.
 */
function scriptSafeJson(json: string): string {
  return JSON.stringify(json).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

/**
 * HTML returned to the popup after the consent round-trip. It signals the opener
 * via a same-origin `localStorage` write (the `storage` event fires in the main
 * window) and closes itself. We use localStorage rather than
 * `window.opener.postMessage` because the app sets
 * `Cross-Origin-Opener-Policy: same-origin`, which severs the opener handle once
 * the popup has visited the provider's domain.
 *
 * `message` can carry attacker-supplied provider error codes, so it is
 * sanitized and HTML/JS-escaped before being embedded in either the visible
 * text or the script payload.
 */
function popupResultHtml(spec: OAuthProviderSpec, ok: boolean, message: string): string {
  const safeMessage = sanitizeMessage(message);
  const payload = JSON.stringify({ provider: spec.id, ok, message: safeMessage, ts: Date.now() });
  const visible = ok ? 'Connected. You can close this window.' : `Connection failed: ${escapeHtml(safeMessage)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(spec.id)}</title></head>
<body style="font-family:system-ui;background:#0b0b0f;color:#e5e7eb;display:grid;place-items:center;height:100vh;margin:0">
<p>${visible}</p>
<script>
  try { localStorage.setItem(${scriptSafeJson(AUTH_RESULT_STORAGE_KEY)}, ${scriptSafeJson(payload)}); } catch (e) { console.error(e); }
  setTimeout(function () { try { window.close(); } catch (e) { /* user closes manually */ } }, ${ok ? 300 : 2500});
</script>
</body></html>`;
}

export function createOAuthHandlers(deps: OAuthHandlerDeps): OAuthHandlers {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const makeState = deps.makeState ?? (() => randomState());
  const { spec, config } = deps;
  const STATE_COOKIE = stateCookieName(spec);
  const REFRESH_COOKIE = refreshCookieName(spec);
  const PATH = cookiePath(spec);

  const cookie = (name: string, value: string, maxAge: number): string =>
    serializeCookie(name, value, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge, path: PATH });

  async function authStart(req: Request): Promise<Response> {
    const state = makeState();
    const redirectUri = redirectUriFor(spec, req.url);
    const location = buildAuthorizeUrl(spec, { clientId: config.clientId, redirectUri, state });
    return new Response(null, {
      status: 302,
      headers: { Location: location, 'Set-Cookie': cookie(STATE_COOKIE, state, STATE_MAX_AGE) },
    });
  }

  async function authCallback(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error');
    const cookies = parseCookies(req.headers.get('cookie'));
    const expectedState = cookies[STATE_COOKIE];
    const clearedState = cookie(STATE_COOKIE, '', 0);

    const html = (ok: boolean, message: string, status: number, setCookies: string[]): Response => {
      const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8' });
      for (const c of setCookies) headers.append('Set-Cookie', c);
      return new Response(popupResultHtml(spec, ok, message), { status, headers });
    };

    if (oauthError) {
      return html(false, oauthError, 400, [clearedState]);
    }
    if (!code || !returnedState || !expectedState || returnedState !== expectedState) {
      return html(false, 'invalid_state', 400, [clearedState]);
    }

    try {
      const tokens = await exchangeCodeForTokens(spec, fetchImpl, config, {
        code,
        redirectUri: redirectUriFor(spec, req.url),
      });
      if (!tokens.refresh_token) {
        // Google only returns a refresh token on first consent; `prompt=consent`
        // in the spec forces it. Surface a clear error if it's still missing.
        return html(false, 'no_refresh_token', 502, [clearedState]);
      }
      return html(true, 'ok', 200, [clearedState, cookie(REFRESH_COOKIE, tokens.refresh_token, REFRESH_MAX_AGE)]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'exchange_failed';
      console.error(`[${spec.id}] code exchange failed:`, message);
      return html(false, 'exchange_failed', 502, [clearedState]);
    }
  }

  async function token(req: Request): Promise<Response> {
    if (req.method !== 'POST') return methodNotAllowed();
    if (!isSameOriginRequest(req)) return originRejected();

    const cookies = parseCookies(req.headers.get('cookie'));
    const refreshToken = cookies[REFRESH_COOKIE];
    if (!refreshToken) {
      return json({ error: 'not_connected' }, 401);
    }
    try {
      const tokens = await refreshAccessToken(spec, fetchImpl, config, refreshToken);
      // Some providers (Microsoft/OneDrive) rotate the refresh token on every
      // refresh and expect the caller to persist the new one — the old value
      // may stop working on the *next* refresh. Dropbox's response never
      // carries `refresh_token`, so this is a no-op for it; nothing here is
      // provider-specific.
      const rotated =
        tokens.refresh_token && tokens.refresh_token !== refreshToken
          ? cookie(REFRESH_COOKIE, tokens.refresh_token, REFRESH_MAX_AGE)
          : null;
      return json(
        {
          access_token: tokens.access_token,
          expires_in: tokens.expires_in,
          account_id: tokens.account_id ?? null,
        },
        200,
        rotated ? { 'Set-Cookie': rotated } : {},
      );
    } catch (err) {
      // Only a *definitive* auth failure — the provider explicitly rejecting
      // the refresh token (OAuth2 returns `invalid_grant` as 400; some
      // providers use 401) — means the token is actually dead and worth
      // discarding. A provider 5xx/429, or a network/timeout failure that
      // never got a status at all (not an `OAuthTokenError`), says nothing
      // about the token's validity — clearing it there would force a full
      // reconnect over what's often a transient blip. Keep the cookie and
      // report a retryable status instead.
      if (err instanceof OAuthTokenError && (err.status === 400 || err.status === 401)) {
        console.error(`[${spec.id}] refresh token rejected (${err.status}), clearing it:`, err.detail);
        return json({ error: 'refresh_failed' }, 401, { 'Set-Cookie': cookie(REFRESH_COOKIE, '', 0) });
      }
      const detail = err instanceof OAuthTokenError
        ? `${err.status}: ${err.detail}`
        : err instanceof Error ? err.message : String(err);
      console.error(`[${spec.id}] token refresh failed transiently, keeping the refresh token:`, detail);
      return json({ error: 'refresh_unavailable' }, 503);
    }
  }

  async function disconnect(req: Request): Promise<Response> {
    if (req.method !== 'POST') return methodNotAllowed();
    if (!isSameOriginRequest(req)) return originRejected();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(REFRESH_COOKIE, '', 0) });
  }

  return { authStart, authCallback, token, disconnect };
}
