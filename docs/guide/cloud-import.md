# Cloud Import (Dropbox, Google Drive, OneDrive)

Load IFC files straight from a cloud storage account instead of downloading
them to disk first. **Dropbox** and **OneDrive / SharePoint** (Microsoft
Graph) share one server-side OAuth abstraction. **Google Drive** is
different: it's a browser-only flow using the Google Picker, with no server
route and no client secret at all — see [Google Drive](#google-drive) below.

## How it works (Dropbox, OneDrive)

```text
Browser ──"Connect"──▶ /api/<provider>/auth-start ──▶ provider consent (popup)
       ◀── refresh-token cookie (httpOnly) ── /api/<provider>/auth-callback
Browser ──POST──▶ /api/<provider>/token ──▶ short-lived access token (in memory)
Browser ──Bearer token──▶ provider API  (list folders, download bytes)
       └─ downloaded File ─▶ existing addModel()/loadFile() pipeline
```

Two properties are deliberate:

- **Privacy preserved.** IFC bytes stream **directly from the provider to the
  browser**. They never pass through ifclite servers — only the OAuth token
  exchange does. This matches the app's local-first posture (see
  [Privacy](privacy.md)).
- **Connection remembered.** The provider's app secret and the long-lived
  *refresh token* stay server-side in an `httpOnly`, `Secure`, `SameSite=Lax`
  cookie scoped to `/api/<provider>`. The browser only ever holds a short-lived
  access token in memory, refreshed on demand. JavaScript can never read the
  refresh token, so an XSS bug can't exfiltrate the long-term credential.

The consent popup signals success back to the app via a same-origin
`localStorage` write (the `storage` event) rather than
`window.opener.postMessage`, because the app sets
`Cross-Origin-Opener-Policy: same-origin` (needed for `SharedArrayBuffer`),
which severs `window.opener` after the cross-origin provider hop.

Google Drive traded this persistent, server-remembered connection away on
purpose — see [Google Drive](#google-drive).

## Architecture

The OAuth flow is identical for Dropbox and OneDrive, so it lives in one
place and each is just a small **spec** (endpoints, scopes, env var names):

| Concern | Location |
| --- | --- |
| Generic OAuth core (URLs, token exchange, cookies) | `server/cloud-oauth/oauth-core.ts` |
| Generic route handlers (testable) | `server/cloud-oauth/oauth-handlers.ts` |
| Dropbox / OneDrive specs | `server/{dropbox/dropbox,onedrive/onedrive}.ts` |
| Vercel edge endpoints | `api/{dropbox,onedrive}/{auth-start,auth-callback,token,disconnect}.ts` |
| Provider abstraction | `apps/viewer/src/services/cloud/types.ts` |
| Shared browser OAuth base | `apps/viewer/src/services/cloud/oauth-provider-base.ts` |
| Browser clients | `apps/viewer/src/services/cloud/{dropbox,onedrive}.ts` |
| Google Drive (Picker, no server) | `apps/viewer/src/services/cloud/google-drive-browser{,-loader}.ts`, `google-gis.d.ts` |
| Provider registry (what the UI lists) | `apps/viewer/src/services/cloud/providers.ts` |
| Importer UI | `apps/viewer/src/components/viewer/cloud/CloudImportDialog.tsx` |
| Tests | `tests/api/cloud-oauth.test.ts` (Dropbox/OneDrive), `apps/viewer/src/services/cloud/google-drive-browser.test.ts` (Google) |

### Adding a Dropbox/OneDrive-style provider

1. Add a spec + `load*Config` / `create*Handlers` (copy `server/onedrive/onedrive.ts`).
2. Add `api/<id>/{auth-start,auth-callback,token,disconnect}.ts` (copy the
   OneDrive wrappers; they're four 14-line files).
3. Add a browser client extending `OAuthCloudProvider` (implement only
   `listFolder` + `download`).
4. Register it in `apps/viewer/src/services/cloud/providers.ts`.
5. Set its `*_CLIENT_ID` / `*_SECRET` env vars.

Google Drive doesn't follow this recipe — it has no server route at all. See
[Google Drive](#google-drive).

## Deployment setup

Dropbox and OneDrive are **disabled unless configured** — each
`/api/<provider>/*` route returns `501 <provider>_not_configured` when its
secrets are absent, and the UI surfaces a clear connect error. Google Drive
follows the same principle but is configured at *build* time instead — see
below.

### Dropbox

1. Create a Dropbox app at <https://www.dropbox.com/developers/apps>
   (*Scoped access* → *Full Dropbox* or *App folder*).
2. Grant scopes: `account_info.read`, `files.metadata.read`,
   `files.content.read`.
3. Add the OAuth redirect URI for every origin you deploy to, e.g.
   `https://ifclite.com/api/dropbox/auth-callback` (plus preview/localhost).
4. Set `DROPBOX_APP_KEY` and `DROPBOX_APP_SECRET`.

### Google Drive

Google Drive runs entirely in the browser: [Google Identity Services](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
for auth and the [Google Picker](https://developers.google.com/drive/picker/guides/overview)
for file selection, both loaded lazily only once you pick "Google Drive" from
the cloud-import menu — nothing is added to `index.html` for other visitors.
There is **no `api/google/*` route, no client secret, and no persistent
server-side connection** — every "Connect" is a fresh Google consent popup.

That's a deliberate trade. The scope requested is `drive.file` only, never
`drive.readonly`: Google classifies `drive.file` as *non-sensitive*, so it
needs **no OAuth verification or CASA security assessment**, whereas
`drive.readonly` is a *restricted* scope that requires both before an app can
be published — a recurring cost, and the reason this integration does not use
it,
and it grants access *only* to files the user explicitly opens through the
Picker — the app can never list or read the rest of the user's Drive. The
cost is that nothing is remembered server-side, so every session starts
disconnected and Drive folder browsing isn't available (the Picker's own UI
replaces it, one file at a time). For a viewer whose job is "open a file
someone points it at," that's an acceptable trade for skipping Google's
verification process entirely.

Setup, entirely in the [Google Cloud Console](https://console.cloud.google.com/):

1. Create (or reuse) a Cloud project and note its **project number** (Cloud
   console → project settings — *not* the project ID).
2. **APIs & Services → Library**: enable the **Google Picker API** and the
   **Google Drive API**.
3. **APIs & Services → OAuth consent screen**: configure it (External is
   fine for personal testing) and add **only** the `drive.file` scope. Since
   it's non-sensitive, no verification review is required — add yourself as
   a test user and you're done.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   type **Web application**. Add the origin(s) you'll run the app from under
   *Authorized JavaScript origins* — e.g. `http://localhost:5173` for local
   dev (no redirect URI needed — this flow never redirects).
5. **APIs & Services → Credentials → Create credentials → API key**. Optionally
   restrict it to the Picker API.
6. In `apps/viewer/`, copy `.env.example` to `.env.local` and set:

   ```bash
   VITE_GOOGLE_CLIENT_ID=<the OAuth client id>.apps.googleusercontent.com
   VITE_GOOGLE_API_KEY=<the API key>
   VITE_GOOGLE_APP_ID=<the project number from step 1>
   ```

7. Restart `vite dev` (or rebuild). The cloud-import menu's "Google Drive"
   entry now runs entirely client-side: Connect opens a Google consent popup,
   then the Google Picker opens for you to choose a file. Only the file you
   explicitly pick is ever touched.

> **These are build-time values, baked into the bundle — and that's fine,
> because they aren't secrets.** `VITE_*` vars are inlined into the built
> JS by Vite; anyone can read `VITE_GOOGLE_CLIENT_ID`/`VITE_GOOGLE_API_KEY`
> out of the shipped bundle, same as they could read them from this page.
> There is no client secret in this flow for them to find. The consequence
> that's easy to miss: a **self-hosted deployment must set its own values in
> its own build environment and rebuild** — copying someone else's client ID
> doesn't work (it's tied to their OAuth consent screen and their allowed
> origins), and setting the env var *after* the build (e.g. only at runtime
> on the server) has no effect, because by then it's not read again — the
> value has to be present when `vite build` runs.
>
> If `VITE_GOOGLE_CLIENT_ID` / `VITE_GOOGLE_API_KEY` are absent, the
> cloud-import menu still shows "Google Drive" (hiding it silently would look
> like a bug), but every action on it rejects with a message naming the two
> missing env vars, instead of hanging or failing silently. See
> `GoogleDriveNotConfiguredProvider` in
> `apps/viewer/src/services/cloud/google-drive-browser.ts`.

### OneDrive (Microsoft Graph)

1. Register an app in the [Microsoft Entra admin center](https://entra.microsoft.com/)
   (App registrations → New registration). Choose the account types you want to
   support (the code uses the `common` tenant, which accepts work/school **and**
   personal Microsoft accounts).
2. Under **Authentication**, add a **Web** platform redirect URI, e.g.
   `https://ifclite.com/api/onedrive/auth-callback`.
3. Under **Certificates & secrets**, create a client secret.
4. The app requests the delegated scopes `offline_access`, `Files.Read.All`,
   `Sites.Read.All`, and `User.Read`. `Files.Read.All` covers the user's
   OneDrive; `Sites.Read.All` lets them browse their followed SharePoint sites'
   document libraries. Enterprise tenants may require admin consent for these.
5. Set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`.

> **OneDrive + SharePoint.** The importer's root offers **My OneDrive** plus
> each **followed SharePoint site** (its default document library). Personal
> Microsoft accounts have no SharePoint tenant at all, so the site list shows
> an inert "SharePoint sites need a work or school account" row instead of
> silently coming up empty; My OneDrive works the same either way. On a
> work/school account where `Sites.Read.All` wasn't consented, or the Graph
> call otherwise fails, the row explains that instead. Browsing a site's
> *non-default* libraries is a possible follow-up.

No client-side env vars are needed for Dropbox or OneDrive — the browser only
talks to `/api/<provider>/*`, then to the provider's API with the short-lived
token. Google Drive is the exception: it's entirely `VITE_GOOGLE_*` env vars,
set at build time — see [Google Drive](#google-drive) above.

## Testing

```bash
pnpm test:api    # runs tests/api/**, including cloud-oauth.test.ts (Dropbox + OneDrive)
```

The handler tests inject a stub `fetch` and run **parametrised over every
server-side provider spec** (Dropbox, OneDrive), so they cover URL building,
the CSRF state round-trip, code exchange, missing-refresh-token handling,
token refresh, cookie clearing on revocation, and disconnect — without
contacting any provider.

Google Drive has no server route to test that way; its coverage lives in the
viewer test suite instead —
`apps/viewer/src/services/cloud/google-drive-browser.test.ts` drives the
provider with fake auth/Picker clients and a mocked `fetch`, covering
connect/disconnect, Picker cancellation, unsupported-file rejection, token
expiry, download failures, and the unconfigured-build fallback — no real
Google session required.

## Roadmap

- **SharePoint non-default libraries** — the importer browses each followed
  site's *default* document library; listing a site's other libraries
  (`/sites/<id>/drives`) would add one more navigation level.
- **Proton Drive** — blocked on Proton shipping third-party auth for their
  Drive SDK (targeted late 2026 / early 2027). Until then the practical path is
  reading a Proton Drive *desktop-sync folder* via the Tauri desktop build.
