# @ifc-lite/source-msgraph

SharePoint / OneDrive (Microsoft Graph) file-source provider for ifc-lite.

Implements `FileSourceProvider` from `@ifc-lite/plugin-api` v2 to browse a
signed-in Microsoft account's OneDrive and the SharePoint sites they follow,
and to download IFC files (and named SharePoint versions) directly into the
viewer. Pure client-side SPA auth via `@azure/msal-browser` v5 — there is no
ifc-lite backend involved and no shared client secret; every user brings
their own Entra app registration.

## Bringing your own Entra app registration

ifc-lite ships no shared Microsoft client ID — Graph delegated permissions
are scoped per app registration, and a shared one would mean every ifc-lite
user's Graph access ran under one organization's identity. Register your own
(free, a few minutes) in the [Entra admin center](https://entra.microsoft.com):

1. **App registrations -> New registration.**
2. **Supported account types**: "Accounts in any organizational directory and
   personal Microsoft accounts" (multi-tenant + consumer). Use a
   single-tenant option instead if you want to restrict this to one
   organization, and set the `authority` preference below to match.
3. **Redirect URI**: platform **Single-page application (SPA)** (not Web —
   SPA is what tells Entra to allow token requests without a client secret),
   URI `https://<your-deployment-host>/msal-redirect.html`. Add
   `http://localhost:3000/msal-redirect.html` too for local dev.
4. **API permissions -> Add a permission -> Microsoft Graph -> Delegated
   permissions**, add: `User.Read`, `Files.Read.All`, `Sites.Read.All`. (
   `openid`, `profile`, `offline_access` are included by every registration
   automatically.) None of these require admin consent as delegated
   permissions — though a tenant's own conditional access policy can still
   force it; if a user's sign-in fails with a consent/admin-approval error,
   that's their tenant's policy, not this app registration.
5. Copy the **Application (client) ID** from the Overview page into this
   provider's "Application (client) ID" setting in Source Settings. Leave
   "Authority" at its default (`https://login.microsoftonline.com/common`)
   unless step 2 restricted you to a single tenant.

No client secret is created or needed anywhere in this flow — SPA-platform
apps authenticate with PKCE, and the client ID is not a secret.

## The redirect-bridge page (`apps/viewer/msal-redirect.html`)

This app sets `Cross-Origin-Opener-Policy: same-origin` on every response
(needed elsewhere for `SharedArrayBuffer`/cross-origin isolation), which
severs the `window.opener` link classic MSAL popup flows depend on to hand
the auth response back to the tab that opened the popup. `@azure/msal-browser`
v5 exists partly to fix this: every flow (including `loginPopup`) instead
routes through a small same-origin **redirect-bridge** page that calls
`broadcastResponseToMainFrame()` from `@azure/msal-browser/redirect-bridge`
and hands the response back over a `BroadcastChannel`, which survives COOP.
`redirectUri` in this provider's MSAL config (see `src/msal-client.ts`)
points at `${window.location.origin}/msal-redirect.html`.

That file lives at `apps/viewer/msal-redirect.html` — the app **root**,
next to `index.html` — rather than under `apps/viewer/public/` as this
package's task brief originally suggested. Reason: Vite's `publicDir` copy
step runs *after* the build and copies every file under `public/` verbatim,
overwriting any same-named build output. The bridge page needs Vite to
actually bundle it (to resolve the real `@azure/msal-browser/redirect-bridge`
import — a bare specifier a raw static file can't resolve in a browser), so
if its source lived in `public/`, the build's correctly-bundled
`dist/msal-redirect.html` would get silently clobbered by the raw,
unprocessed source afterward. Putting the source outside `publicDir` and
wiring it into `build.rollupOptions.input` (see `apps/viewer/vite.config.ts`)
avoids that entirely — this is Vite's own documented multi-page-app pattern.
Verified locally: an isolated `vite build` against just this entry resolves
and bundles real `@azure/msal-browser` internals (88 modules transformed).

**`apps/viewer/vercel.json` needs one change this package cannot make**
(it's outside this package's ownership). The current `headers` block applies
`Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` to `/(.*)` — every
route, including this one. The bridge page's popup/`BroadcastChannel`
handshake needs to run **without** COOP/COEP, so add a rule overriding both
back to `unsafe-none` for this one path, placed after the existing catch-all
block so it wins for this route:

```json
{
  "source": "/msal-redirect.html",
  "headers": [
    { "key": "Cross-Origin-Opener-Policy", "value": "unsafe-none" },
    { "key": "Cross-Origin-Embedder-Policy", "value": "unsafe-none" }
  ]
}
```

Without this, sign-in will hang or silently fail in production even though
`vite build` succeeds and local dev (which doesn't send these headers to
this path either, once the same override is mirrored in
`apps/viewer/vite.config.ts`'s dev `server.headers`, also outside this
package's ownership) may appear to work.

`apps/viewer/package.json` gained a direct dependency on
`@azure/msal-browser` (matching this package's pinned version) so the bridge
page's static import resolves under pnpm's per-package `node_modules` —
without it, the app-level bundling of `msal-redirect.html` fails to resolve
the import even though this package's own build is unaffected.

## Capabilities (honestly)

- `containerListing: 'direct-children'` — one level at a time; Graph has a
  real per-folder `/children` endpoint, so there's no reason to sweep a
  whole drive.
- `listFilesIsRecursive: false` — `listFiles` returns only the queried
  container's direct children.
- `revisionHistory: true`, `changeDetection: true`, `search: true`.
- `projectsAreDiscoverableOnly: true` — delegated Graph has **no** "list every
  SharePoint site I can see" endpoint. `listProjects` with no `query` returns
  "My OneDrive" plus `/me/followedSites` (which carries Microsoft's own
  documented known-issue about occasionally-incorrect results — a failure
  there is swallowed and logged, never taking down the OneDrive entry). With
  a `query`, it calls `/sites?search=`, which is index-backed and can miss
  sites that exist. There is no "browse every site" affordance because Graph
  doesn't have one; a future improvement could add a paste-a-SharePoint-URL
  path using `/sites/{hostname}:/{server-relative-path}` to resolve a known
  site directly, which isn't implemented yet.
- Consumer Microsoft accounts have no SharePoint sites at all — `listProjects`
  still works for them (OneDrive only), and `/me/drives` falling back to the
  singular `/me/drive` covers accounts where the plural endpoint isn't
  supported.

## Ids

Graph item ids are unique only *within* a drive. Rather than a side-table
mapping container id -> drive id (which `SourceFileRef`'s
`(projectId, containerId, fileId)` triple exists specifically to make
unnecessary — see `packages/plugin-api/src/types.ts`), the drive id is
encoded directly into this provider's own container ids as
`{driveId}::{itemId}` (bare `driveId` for a drive's own root). See
`src/ids.ts`. The host treats every id as opaque, so this is safe, and it
means `download`/`listRevisions`/`watchRevisions` never need a lookup beyond
the `SourceFileRef` they're handed.

## Known sharp edges

- **Search false positives.** `GET /drives/{id}/root/search(q=...)` matches
  file *content*, not just names — a Word doc whose body happens to mention
  "ifc" is a legitimate hit from Graph's point of view. `searchFiles` always
  filters results against `filter.namePatterns` (or, if none is given, the
  same `['*.ifc', '*.ifcx', '*.ifc5']` default the viewer's host always
  passes) before returning them.
- **Search lag.** The search index lags live children listings by minutes;
  a just-uploaded file may not appear in search yet even though
  `listFiles`/`listContainers` already see it.
- **Delta resync on 410.** `watchRevisions` packs a `{ driveId: deltaLink }`
  map into the contract's single opaque cursor (one string standing in for
  as many per-drive delta streams as are in play). A `410 Gone` on a stored
  deltaLink is resynced silently via `?token=latest` — changes that happened
  during the gap are not replayed, only detected from that point forward.
- **Forced daily re-auth.** Refresh tokens issued to SPA redirect URIs expire
  after roughly 24 hours. `getAccessToken` tries `acquireTokenSilent` first,
  falls back to `acquireTokenPopup` on `InteractionRequiredAuthError`, and if
  that also fails (most likely because the call isn't running from a user
  gesture) throws `GraphAuthExpiredError` instead of the raw MSAL failure —
  callers should present that as "sign in again," not tear down whatever
  model is already loaded.
- **Pre-signed download URLs expire fast.** `@microsoft.graph.downloadUrl`
  lives roughly an hour, sometimes only minutes per Microsoft's own docs, and
  must never be cached. `download()` fetches a fresh one on every call.

## Testing

`pnpm --filter @ifc-lite/source-msgraph test` — all green, no real network,
no real MSAL:

- `test/mapping.test.ts` — pure unit tests for name/mime filtering (including
  the search content-match-rejection default), composite id encode/decode,
  and item-to-domain-model mapping (cTag/eTag/id fallback chain, SharePoint
  version labels kept as opaque strings).
- `test/provider.test.ts` — the provider driven end-to-end against a mocked
  `ctx.fetch`/`ctx.fetchPublic` and a fake `SourceAuth`/token source (no MSAL
  construction happens in any test). Covers: `@odata.nextLink` cursor
  pagination, direct-children correctness (folders vs. files, composite ids),
  the two-step download (`downloadUrl` fetch via `ctx.fetch`, content fetch
  via `ctx.fetchPublic` — asserted to carry **no** `Authorization` header),
  named-version download bypassing `fetchPublic` entirely, SharePoint version
  label handling, `watchRevisions`'s delta-cursor seed/round-trip/410-resync,
  abort-signal propagation (both a forwarded signal and a rejected fetch
  surfacing as a rejection, not a swallow), and `testConnection`.
- `test/conformance.test.ts` — runs `@ifc-lite/source-fixture`'s shared
  `runConformanceSuite` (manifest shape, container-listing mode, paging
  termination/dedup/reconstruction, download-by-revision, abort, optional
  methods matching declared capabilities) against this provider backed by a
  small deterministic mock Graph server (`test/graph-mock.ts`) — two drives,
  nested folders, a file with two distinct-byte revisions. This package's own
  `provider.test.ts` predates `source-fixture` publishing its conformance kit
  mid-session; once it appeared, this was wired in and passes.

**Not tested**: anything requiring a real Entra tenant, a real MSAL popup, or
a live Graph endpoint — none of that is possible from CI, and the whole
point of the two seams (`GraphTokenSource`/`ctx.fetch`+`ctx.fetchPublic`) is
that the provider never needs to reach past them to be exercised.
