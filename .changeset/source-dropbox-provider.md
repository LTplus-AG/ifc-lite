---
'@ifc-lite/source-dropbox': minor
'@ifc-lite/viewer': patch
---

Add `@ifc-lite/source-dropbox`: a Dropbox file-source provider implementing `FileSourceProvider` from `@ifc-lite/plugin-api`. Browses the signed-in user's Dropbox (folders and files), lists version history, and downloads any revision — current or historical — directly through `files/download`, using Dropbox's `"rev:<rev-id>"` path form for a specific historical revision (Dropbox serves this as a normal, non-redirecting, CORS-safe response, unlike Microsoft Graph's browser-only current-revision limitation).

Authentication is delegated OAuth 2.0 Authorization Code + PKCE (`@ifc-lite/oauth-pkce`), scope `account_info.read files.metadata.read files.content.read` — no client secret. Getting a refresh token requires `token_access_type=offline` on the authorization request (a Dropbox-specific requirement, distinct from Microsoft Graph's `offline_access` scope); omitting it silently yields a session that stops working the moment its access token expires. No client ID is committed; it's a required, non-secret `clientId` preference the deployment configures (see the package README for what to register in the Dropbox App Console, including the 50-linked-user production-approval constraint).

Registered alongside `@ifc-lite/source-dalux` and `@ifc-lite/source-msgraph` in the viewer's `createRegisteredProviders()`.

The popup-callback channel this needs (`OAUTH_CALLBACK_CHANNEL`, `waitForOAuthCallback` and the `OAuthCallbackMessage` / `WaitForOAuthCallbackOptions` types) is imported from `@ifc-lite/oauth-pkce`, which already ships it. It lives there, not in this provider, because the defect it works around is a property of the browser's COOP handling and of that package's popup-based authorization flow, not of any one provider: every provider built on it inherits both the failure and the fix. `@ifc-lite/source-dropbox` keeps no copy of its own and deliberately does not re-export those names.

The popup handoff is a `BroadcastChannel` from the redirect page, not the usual `popup.closed`/`popup.location` poll. A host that serves `Cross-Origin-Opener-Policy: same-origin` (the viewer does, for `SharedArrayBuffer`) has its opener link severed by the cross-origin authorization hop: `popup.closed` reads `true` while the popup is visibly open, so the poll loop rejects every sign-in as "cancelled" before the user has even consented. The viewer now serves the redirect path as a small static page (`apps/viewer/public/oauth/dropbox/callback.html`, routed in dev by `apps/viewer/vite-plugins/oauth-callback.ts` and in production by a `vercel.json` rewrite) instead of letting the SPA fallback boot a second copy of the whole application inside the popup.
