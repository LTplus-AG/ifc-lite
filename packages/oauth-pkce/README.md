# @ifc-lite/oauth-pkce

Browser OAuth 2.0 Authorization Code flow with PKCE (RFC 7636), for a public
client — no client secret, ever. This package is the shared auth primitive
for ifc-lite file-source providers whose CDE uses OAuth (Google Drive,
Dropbox, SharePoint/OneDrive, ...); it does not implement any provider.

## Scope

Provided:
- PKCE `code_verifier` / `code_challenge` (S256) generation, via Web Crypto
  (`crypto.getRandomValues`, `crypto.subtle.digest`) — never `Math.random()`.
- Authorization URL construction with a CSRF `state` parameter, and
  validation of that `state` (plus the redirect origin) when the user comes
  back.
- Authorization-code -> token exchange, and refresh-token -> token exchange
  (RFC 6749 §4.1.3 and §6).
- `TokenManager`: persists a token set behind a small `TokenStorage`
  interface and serves a currently-valid access token, refreshing
  transparently and de-duplicating concurrent refreshes onto a single
  in-flight request.

Explicitly **not** provided, by design:
- Any actual provider implementation (Google Drive, Dropbox, OneDrive, ...).
- Any registered OAuth client ID.
- Any redirect-URI registration with a provider.

Each of those is provider-specific and belongs in that provider's own
package, built on top of this one.

## Token storage — the trade-off, and this package's default

`TokenStorage` is a caller-supplied interface (`get`/`set`/`delete`); this
package never picks a storage medium for you. The two obvious choices have
opposite failure modes:

- **`localStorage`** (or any persistent storage) survives a page reload —
  good UX — but is readable by any script running on the page, so an XSS
  bug anywhere in the app can exfiltrate a live refresh token, not just the
  current session.
- **In-memory** (a plain object/`Map`) is not reachable from another script
  context and leaves nothing on disk, but the user is signed out on every
  reload — for a page that reloads often (navigation, a crashed WebGPU
  context, a deploy), that's a real cost.

This package does not default to either — `TokenManagerConfig.storage` is
required, not optional, so the choice is visible at the call site rather
than silently defaulting to whichever is convenient. That said, if asked:
prefer in-memory (or `sessionStorage`, which shares the readability risk but
at least scopes it to the tab) as the starting point for a new provider, and
only move to `localStorage` once the "signed out on every reload" cost is
shown to matter for that provider's actual usage pattern. A refresh token is
a longer-lived bearer credential than the access token it mints, so it is the
one this decision is really about.

`@ifc-lite/plugin-api`'s `KeyValueStore` (the interface providers already get
via `PluginContext.storage`, `localStorage`-backed in the reference host) is
structurally compatible with `TokenStorage` — it can be passed straight
through without an adapter — but that is the host's existing choice for
provider *preferences* (e.g. Dalux's API key), not an endorsement for tokens
specifically; make the call above before reusing it for a new provider.

## Not included on purpose

- Token *revocation* (a provider-specific endpoint, if it has one at all) —
  call it yourself before `TokenManager.clear()` if you want server-side
  revocation on sign-out.
- Popup vs. full-page-redirect orchestration — `createAuthorizationRequest`
  returns a URL; navigating to it (or opening it in a popup) is the caller's
  job, per the plugin contract's `SourceAuth.signIn` (interactive, called
  only from a user gesture).
