# Cloud Import (Dropbox, Google Drive, OneDrive)

Load IFC files straight from a cloud storage account instead of downloading
them to disk first. Providers ship behind one provider-agnostic abstraction;
today that's **Dropbox**, **Google Drive**, and **OneDrive / SharePoint**
(Microsoft Graph).

## How it works

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

## Architecture

The OAuth flow is identical for every provider, so it lives in one place and
each provider is just a small **spec** (endpoints, scopes, env var names):

| Concern | Location |
| --- | --- |
| Generic OAuth core (URLs, token exchange, cookies) | `server/cloud-oauth/oauth-core.ts` |
| Generic route handlers (testable) | `server/cloud-oauth/oauth-handlers.ts` |
| Dropbox / Google / OneDrive specs | `server/{dropbox/dropbox,google/google,onedrive/onedrive}.ts` |
| Vercel edge endpoints | `api/{dropbox,google,onedrive}/{auth-start,auth-callback,token,disconnect}.ts` |
| Provider abstraction | `apps/viewer/src/services/cloud/types.ts` |
| Shared browser OAuth base | `apps/viewer/src/services/cloud/oauth-provider-base.ts` |
| Browser clients | `apps/viewer/src/services/cloud/{dropbox,google-drive,onedrive}.ts` |
| Provider registry (what the UI lists) | `apps/viewer/src/services/cloud/providers.ts` |
| Importer UI | `apps/viewer/src/components/viewer/cloud/CloudImportDialog.tsx` |
| Tests | `tests/api/cloud-oauth.test.ts` |

### Adding a provider

1. Add a spec + `load*Config` / `create*Handlers` (copy `server/google/google.ts`).
2. Add `api/<id>/{auth-start,auth-callback,token,disconnect}.ts` (copy the
   Google wrappers; they're four 14-line files).
3. Add a browser client extending `OAuthCloudProvider` (implement only
   `listFolder` + `download`).
4. Register it in `apps/viewer/src/services/cloud/providers.ts`.
5. Set its `*_CLIENT_ID` / `*_SECRET` env vars.

## Deployment setup

Cloud import is **disabled per-provider unless configured** — each
`/api/<provider>/*` route returns `501 <provider>_not_configured` when its
secrets are absent, and the UI surfaces a clear connect error.

### Dropbox

1. Create a Dropbox app at <https://www.dropbox.com/developers/apps>
   (*Scoped access* → *Full Dropbox* or *App folder*).
2. Grant scopes: `account_info.read`, `files.metadata.read`,
   `files.content.read`.
3. Add the OAuth redirect URI for every origin you deploy to, e.g.
   `https://ifclite.com/api/dropbox/auth-callback` (plus preview/localhost).
4. Set `DROPBOX_APP_KEY` and `DROPBOX_APP_SECRET`.

### Google Drive

1. In the [Google Cloud Console](https://console.cloud.google.com/), create an
   OAuth 2.0 **Web application** client.
2. Enable the **Google Drive API** for the project.
3. Add the authorized redirect URI(s), e.g.
   `https://ifclite.com/api/google/auth-callback`.
4. The `drive.readonly` scope is *sensitive* — for public production use the
   app must pass Google's OAuth verification. Until then, add testers on the
   OAuth consent screen.
5. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

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

No client-side env vars are needed — the browser only talks to
`/api/<provider>/*`, then to the provider's API with the short-lived token.

## Testing

```bash
pnpm test:api    # runs tests/api/**, including cloud-oauth.test.ts
```

The handler tests inject a stub `fetch` and run **parametrised over every
provider spec**, so they cover URL building, the CSRF state round-trip, code
exchange, missing-refresh-token handling, token refresh, cookie clearing on
revocation, and disconnect — without contacting any provider.

## Roadmap

- **SharePoint non-default libraries** — the importer browses each followed
  site's *default* document library; listing a site's other libraries
  (`/sites/<id>/drives`) would add one more navigation level.
- **Proton Drive** — blocked on Proton shipping third-party auth for their
  Drive SDK (targeted late 2026 / early 2027). Until then the practical path is
  reading a Proton Drive *desktop-sync folder* via the Tauri desktop build.
