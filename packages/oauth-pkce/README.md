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
- `waitForOAuthCallback`: the popup-side handoff, i.e. how the redirect page
  gets the authorization code back to the page that opened the popup. See
  "The popup handoff" below — this is not the mechanism you would expect.

Explicitly **not** provided, by design:
- Any actual provider implementation (Google Drive, Dropbox, OneDrive, ...).
- Any registered OAuth client ID.
- Any redirect-URI registration with a provider.

Each of those is provider-specific and belongs in that provider's own
package, built on top of this one.

## The popup handoff — why it is not `popup.closed`

A provider opens the authorization URL in a popup and needs the redirect URL
back. The obvious way is to poll `popup.closed` and `popup.location.href`
until the redirect lands on the app's own origin. **That does not work in a
cross-origin-isolated host, and it fails misleadingly.**

A host that wants `SharedArrayBuffer` must send
`Cross-Origin-Opener-Policy: same-origin` (the ifc-lite viewer does). Under
that header, opening a *cross-origin* popup severs the opener relationship:
the `WindowProxy` `window.open` returns is a stub that reports
`closed === true` while the window is visibly open, and whose `location`
throws `SecurityError`. Probed live against the running viewer, with a
same-origin control popup behaving normally in the same probe — so the cause
is the popup being cross-origin, and every authorization endpoint is on
someone else's origin. The poll loop therefore rejects every sign-in as
"cancelled" on its first tick, while the user is still on the consent screen.

What still works: the redirect lands back on the app's own origin, so the
callback page is same-origin with its opener and can hand the result over a
`BroadcastChannel`, which is scoped by origin and unaffected by the severed
opener link. `waitForOAuthCallback` is the listening half; the host serves
the callback page and posts `OAUTH_CALLBACK_CHANNEL` messages of shape
`OAuthCallbackMessage` from it (that page must be a static file, not the SPA
fallback, or the popup boots a second copy of the whole application). The
opener never touches the popup at all.

Two consequences to know before changing this:

- Messages are routed by the sign-in attempt's `state`, so two providers or
  two tabs signing in concurrently cannot complete each other's flow. That
  routing check is *not* the security check — `parseAuthorizationCallback`
  still validates `state` and the redirect origin authoritatively.
- **Cancellation is not detectable.** `popup.closed` is the only signal a
  browser gives for "the user closed the window", and it is precisely what
  COOP made unusable. A closed popup falls through to the caller's timeout.
  This is a deliberate trade: there is no correct substitute signal.

`src/callback-channel.ts` carries the full probe and reasoning.

## Token storage — the trade-off, and this package's default

`TokenStorage` is a caller-supplied interface (`get`/`set`/`delete`); this
package never picks a storage medium for you. `TokenManager` serializes every
`get`/`set`/`delete` it issues against a given storage key through its own
internal queue, so a `TokenStorage` implementation never needs to guard
against concurrent calls *from the same `TokenManager` instance* — it does
not need to be atomic, and it does not need `set`/`delete` calls it receives
to complete in the order they were invoked. (It's still up to the caller to
avoid running two `TokenManager` instances against the same storage key
concurrently — the serialization is per-instance, not per-key across
instances.) A refresh's "is my session still current, and if so, persist the
new tokens" check and write happen as a single unit on that queue, which is
also why `TokenManager.clear()` (sign-out) can end up waiting for whatever
storage operation was already ahead of it — in practice a refresh write, at
most one storage round trip away.

The two obvious storage-medium choices have opposite failure modes:

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
