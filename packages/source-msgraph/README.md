# @ifc-lite/source-msgraph

Microsoft Graph (OneDrive / SharePoint) file-source provider for ifc-lite.

Implements `FileSourceProvider` from `@ifc-lite/plugin-api` to browse the
signed-in user's OneDrive, and download IFC files directly into the viewer.
Authentication is delegated OAuth 2.0 Authorization Code + PKCE, built on
`@ifc-lite/oauth-pkce` — never a client secret.

## Scope (v1)

- **One project**: the signed-in user's own default drive (`/me/drive`).
  Delegated `Files.Read` grants no "list every SharePoint site I can see"
  endpoint — that needs the higher-privileged, admin-consentable
  `Sites.Read.All` — so this provider doesn't pretend to discover sites it
  structurally can't enumerate. Browsing a specific SharePoint site is a
  natural follow-up (an app registration with `Sites.Read.All` plus a
  "paste a site URL" affordance), not implemented here.
- **Folder-organized files only.** `listContainers` returns the drive
  root's real child folders directly (matching the plugin contract's "top
  level" shape exactly, `parentId: undefined`), and folders nest the same
  way real Graph `driveItem`s do. A file sitting directly at the drive root
  — not inside any folder — is not currently listable: there is no
  `SourceContainer` a host would address it through. Most real OneDrive
  usage is folder-organized; this is a known v1 gap, not a design dead end
  (a synthetic root-level container is the natural extension).
- **Current revision only.** `listRevisions` lists version history
  (`GET .../versions`), but `download()` can only fetch the *current*
  revision — see "Why not `/content`" below for why, and
  `capabilities.downloadHistoricalRevisions: false` in the manifest for how
  that's declared to the host.

## Why not `/content`

Downloading goes through the item's pre-signed `@microsoft.graph.downloadUrl`
property, fetched via `ctx.fetchPublic` (no `Authorization` header) — never
`GET .../content` directly.

Per Microsoft's own docs ("Download driveItem content", section "Downloading
files in JavaScript apps" — `learn.microsoft.com/graph/api/driveitem-get-content`,
checked 2026-08-15): `/content` returns a `302 Found` redirect to that same
pre-signed URL, and a browser can't follow a `302` when the request that
triggered it required a CORS preflight (attaching `Authorization` does). The
docs' own recommended fix is exactly this provider's approach: select
`@microsoft.graph.downloadUrl` and fetch that URL directly — it's
preauthenticated, so no `Authorization` header (and therefore no preflight)
is needed.

The same 302-redirect shape applies to a *historical* version's content
(`GET .../versions/{id}/content`), and `driveItemVersion` exposes no
`@microsoft.graph.downloadUrl` equivalent — hence
`downloadHistoricalRevisions: false`.

## Auth

Delegated OAuth 2.0 Authorization Code + PKCE (`@ifc-lite/oauth-pkce`), scope
`offline_access https://graph.microsoft.com/Files.Read`. `Files.Read` is the
least-privileged permission for reading file content and needs no admin
consent; `offline_access` is required separately for a refresh token to be
issued at all (the Microsoft identity platform's own docs: `refresh_token`
is "[o]nly provided if offline_access scope was requested").

Sign-in is a popup, not a full-page redirect: `signIn()` opens
`https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize` in a
popup and waits for the callback page at `REDIRECT_PATH` to broadcast the
result back.

**The popup is never inspected, and the host must serve `REDIRECT_PATH`
itself.** Both follow from `Cross-Origin-Opener-Policy: same-origin`, which
any host that wants `SharedArrayBuffer` (the ifc-lite viewer does) has to
send. Under that header, opening a *cross-origin* popup severs the opener
relationship: the `WindowProxy` `window.open` returns reports `closed === true`
while the window is visibly open, and reading `location` throws
`SecurityError`. The classic poll loop therefore rejects every sign-in as
"cancelled" on its first tick, with the popup still on the consent screen and
the authorization code stranded. So:

- The redirect lands back on this app's own origin, and that page hands the
  result to the opener over a `BroadcastChannel`. The waiting side is
  `waitForOAuthCallback` in `@ifc-lite/oauth-pkce`
  (`packages/oauth-pkce/src/callback-channel.ts` carries the name, the message
  shape and the live probe) — it is shared with every other provider built on
  that package, because the failure is a property of the popup being
  cross-origin rather than of any one identity provider. The host serves the
  page: see `apps/viewer/public/oauth/msgraph/callback.html` plus the
  dev-server route in `apps/viewer/vite-plugins/oauth-callback.ts` and the
  `vercel.json` rewrite. Without such a route the SPA fallback answers the
  redirect with the whole application, which boots a second copy of the app
  inside the popup.
- Messages are routed by `state`, so two providers (or two tabs) signing in at
  once cannot complete each other's flow. `state` is then re-validated by
  `parseAuthorizationCallback` before the code is used.
- **Cancellation is not detectable.** `popup.closed` is the only signal a
  browser offers for "the user closed the window", and it is exactly what COOP
  made unusable. Closing the popup falls through to the five-minute timeout
  instead of reporting a cancellation.

**Note on session length**: per Microsoft's docs, a refresh token issued to a
`spa`-type redirect URI is capped at a 24-hour lifetime regardless of
`offline_access` — re-authentication (normally silent, via the identity
platform's own session) is required at least once a day.

## What the app registration needs (maintainer action — not done here)

No client ID is committed to this package; it's a required, non-secret
`clientId` preference (see `manifest.ts`) the host/deployment configures.
Registering an Azure AD application needs:

- **Client type**: Single-page application (SPA) — public client, PKCE, no
  client secret.
- **Redirect URI**: `<app origin>/oauth/msgraph/callback` (the exact path is
  `REDIRECT_PATH` in `src/auth.ts`), registered with type `spa` — the
  `spa` type is what enables CORS on the token endpoint; a `web`-type
  redirect URI will fail with a CORS error on token exchange.
- **API permissions (delegated)**: `Files.Read`, `offline_access`. Neither
  needs admin consent for a standard tenant. No `Sites.Read.All` — not used
  by this provider (see "Scope" above).
- **Supported account types**: whichever matches the `tenant` preference the
  deployment sets (default `common` — both work/school and personal
  Microsoft accounts).

## Token storage

Tokens are persisted through `ctx.storage` (`KeyValueStore`), the same
`localStorage`-backed store used for other providers' preferences in the
reference host. See the trade-off documented in `@ifc-lite/oauth-pkce`'s
README before changing this — a refresh token is a longer-lived bearer
credential than the access token it mints.

## CORS

Every Graph API call and the OAuth token endpoint send real CORS headers for
an app registered with a `spa` redirect URI — no same-origin relay is needed,
unlike `@ifc-lite/source-dalux`.
