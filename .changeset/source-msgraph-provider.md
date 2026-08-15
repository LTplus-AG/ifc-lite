---
'@ifc-lite/source-msgraph': minor
'@ifc-lite/viewer': patch
---

Add `@ifc-lite/source-msgraph`: a Microsoft Graph (OneDrive/SharePoint) file-source provider implementing `FileSourceProvider` from `@ifc-lite/plugin-api`. Browses the signed-in user's OneDrive (folders and files), lists version history, and downloads the current revision of a file via Graph's pre-signed `@microsoft.graph.downloadUrl` — never `GET .../content` directly, which 302-redirects in a way a browser can't follow under a CORS preflight.

Authentication is delegated OAuth 2.0 Authorization Code + PKCE (`@ifc-lite/oauth-pkce`), scope `offline_access https://graph.microsoft.com/Files.Read` — no admin consent required, no client secret. No client ID is committed; it's a required, non-secret `clientId` preference the deployment configures (see the package README for what to register in Azure AD).

Registered alongside `@ifc-lite/source-dalux` in the viewer's `createRegisteredProviders()`.
