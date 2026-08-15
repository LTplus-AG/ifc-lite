# @ifc-lite/source-dropbox

Dropbox file-source provider for ifc-lite.

Implements `FileSourceProvider` from `@ifc-lite/plugin-api` to browse the
signed-in user's Dropbox, and download IFC files directly into the viewer.
Authentication is delegated OAuth 2.0 Authorization Code + PKCE, built on
`@ifc-lite/oauth-pkce` — never a client secret. PKCE is Dropbox's own
explicitly recommended flow for a browser app that cannot keep a
`client_secret` confidential (`developers.dropbox.com/oauth-guide`, "PKCE"
section, checked 2026-08-15).

## Scope (v1)

- **One project**: the signed-in user's own Dropbox. There is no "list every
  team space I can see" endpoint reachable with this provider's scopes —
  browsing a specific team space is a natural follow-up, not implemented
  here. Mirrors `@ifc-lite/source-msgraph`'s single-project (`/me/drive`)
  scope for the same structural reason.
- **Folder-organized files only.** `listContainers` returns the account
  root's real child folders directly (`parentId: undefined` at the top
  level), and folders nest the same way real Dropbox folders do. A file
  sitting directly at the account root is not currently listable through
  this provider — `listFiles` requires a `containerId` a host can only get
  from `listContainers`, and there is no synthetic "root container" handed
  out (see the doc comment on `ROOT_CONTAINER_ID` in `mapping.ts`). Known v1
  gap, not a design dead end — a synthetic root-level container is the
  natural extension, same as documented for `source-msgraph`.
- **Historical revisions are both listable and downloadable** — the one
  place this provider does *more* than `source-msgraph`: Dropbox's
  `files/download` accepts a `"rev:<rev-id>"` path directly (see "Downloading
  a specific revision" below), unlike Microsoft Graph, which can only serve
  the *current* revision from a browser.
- **Change detection reports updates, not deletions.** Dropbox's
  `DeletedMetadata` (what a deleted entry decodes to) carries no `id` field —
  only `name`/`path_lower` — and this provider addresses every tracked file
  by opaque `id`. A deletion reported by the `files/list_folder/continue`
  feed therefore cannot be matched back to a tracked ref without guessing by
  name/path, which this provider deliberately does not do (a same-named file
  elsewhere could misfire). See the doc comment on `watchRevisions()` in
  `provider.ts`.

## Downloading a specific revision

`download()` embeds `ref.revisionId` directly in the `path` argument as
`"rev:<rev-id>"` rather than the file's normal path/id. Per Dropbox Community
guidance and `dropbox/revision-browser`'s reference implementation (checked
2026-08-15): the older, separate `rev` request parameter on this endpoint is
deprecated in favor of this form. A `rev` string is globally unique to one
file's one revision, so no extra metadata lookup is needed to validate it —
an invalid or mismatched rev is rejected by Dropbox itself.

## CORS

Dropbox's API supports CORS for browser apps on both `api.dropboxapi.com`
(listing/search/revisions/account) and `content.dropboxapi.com`
(`files/download`) — no same-origin relay is needed, unlike
`@ifc-lite/source-dalux`. `files/download` sends its argument in a
`Dropbox-API-Arg` request header (JSON-encoded) rather than the request body,
which — combined with the `Authorization` header every authenticated call
already needs — makes every download request a CORS "non-simple" request:
the browser issues a preflight `OPTIONS` round trip before the real `POST`.
This costs latency, not correctness — Dropbox answers that preflight (see
`github.com/dropbox/dropbox-sdk-js` issue #111 and Dropbox Community threads
on `Access-Control-Allow-Origin`, checked 2026-08-15) — and is the *opposite*
failure mode from Microsoft Graph's `/content` endpoint, whose `302` redirect
a CORS preflight cannot follow at all. There is no pre-signed-URL indirection
here and no need for `ctx.fetchPublic`/`publicNetwork`: `files/download` is a
normal authenticated POST.

## Pagination

`files/list_folder` and `files/list_folder/continue` share one opaque
`cursor`/`has_more` shape across listing folders, files, and (via
`files/list_folder/continue` again) the `changeDetection` feed. This differs
from Microsoft Graph's `@odata.nextLink`/`@odata.deltaLink` split in one
respect worth knowing: `files/list_revisions` (revision history) paginates
through a different mechanism — `has_more` plus `before_rev` (Dropbox's own
cap on `limit`: 100, default 10) rather than an opaque token. `listRevisions()`
in `provider.ts` surfaces the last page's oldest revision id as `Page.cursor`
and forwards a supplied cursor back as `before_rev`, so callers follow it the
same way they follow every other paged method here.

## Auth

Delegated OAuth 2.0 Authorization Code + PKCE (`@ifc-lite/oauth-pkce`), scope
`account_info.read files.metadata.read files.content.read` — least-privileged
read-only access.

**Refresh tokens require `token_access_type=offline`.** Per Dropbox's own
OAuth guide (checked 2026-08-15): omitting this parameter on the
*authorization* request (not the token request) silently yields a
short-lived-only access token with no `refresh_token` in the response at
all — sign-in still "succeeds," and the session just stops working again the
moment that access token expires, with nothing in the flow that visibly
failed. `signIn()` in `auth.ts` sets it via `createAuthorizationRequest`'s
`extraParams`, and `test/auth.test.ts` has a dedicated regression test that
inspects the built authorization URL for exactly this parameter.

Sign-in is a popup, not a full-page redirect: `signIn()` opens
`https://www.dropbox.com/oauth2/authorize` in a popup and polls it for a
same-origin redirect back to this app.

## What the app registration needs (maintainer action — not done here)

No app key is committed to this package; it's a required, non-secret
`clientId` preference (see `manifest.ts`) the host/deployment configures.
Registering a Dropbox API app (Dropbox App Console) needs:

- **API**: "Scoped access".
- **Access type**: whichever fits the deployment — "App folder" is the most
  restrictive; "Full Dropbox" is required if browsing outside a
  provisioned app folder is wanted. Either way this provider itself requests
  no more than the scopes below.
- **Permissions (scopes)**, enabled on the app's Permissions tab and
  requested via this provider's `scope`: `account_info.read`,
  `files.metadata.read`, `files.content.read`. No write scopes — this
  provider is read-only.
- **OAuth 2 redirect URI**: `<app origin>/oauth/dropbox/callback` (the exact
  path is `REDIRECT_PATH` in `src/auth.ts`).
- **Client type**: public client, PKCE — no client secret is generated or
  used by this provider.

### The 50-linked-user production-approval wall

A Dropbox app in development mode can link up to 500 Dropbox accounts, but
the moment it links its **50th** user, Dropbox starts a **two-week window**
to apply for and receive production status; miss the window and the app is
frozen from linking any *additional* users until production status is
granted (already-linked users are unaffected). This is a maintainer-facing
process constraint to plan around — apply for production status well before
50 real users sign in — not an engineering blocker this package works around.

## Token storage

Tokens are persisted through `ctx.storage` (`KeyValueStore`), the same
`localStorage`-backed store used for other providers' preferences in the
reference host. See the trade-off documented in `@ifc-lite/oauth-pkce`'s
README before changing this — a refresh token is a longer-lived bearer
credential than the access token it mints.
