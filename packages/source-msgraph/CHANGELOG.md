# @ifc-lite/source-msgraph

## 0.2.0

### Minor Changes

- [#2633](https://github.com/LTplus-AG/ifc-lite/pull/2633) [`c706f34`](https://github.com/LTplus-AG/ifc-lite/commit/c706f3452df4ab64a17966d5e965cf6518ccd417) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Add `@ifc-lite/source-msgraph`: a Microsoft Graph (OneDrive/SharePoint) file-source provider implementing `FileSourceProvider` from `@ifc-lite/plugin-api`. Browses the signed-in user's OneDrive (folders and files), lists version history, and downloads the current revision of a file via Graph's pre-signed `@microsoft.graph.downloadUrl` — never `GET .../content` directly, which 302-redirects in a way a browser can't follow under a CORS preflight.
  
  Authentication is delegated OAuth 2.0 Authorization Code + PKCE (`@ifc-lite/oauth-pkce`), scope `offline_access https://graph.microsoft.com/Files.Read` — no admin consent required, no client secret. No client ID is committed; it's a required, non-secret `clientId` preference the deployment configures (see the package README for what to register in Azure AD).
  
  Registered alongside `@ifc-lite/source-dalux` in the viewer's `createRegisteredProviders()`.
  
  The popup handoff is a `BroadcastChannel` from the redirect page, not the usual `popup.closed`/`popup.location` poll. A host that serves `Cross-Origin-Opener-Policy: same-origin` (the viewer does, for `SharedArrayBuffer`) has its opener link severed by the cross-origin authorization hop: `popup.closed` reads `true` while the popup is visibly open, so the poll loop rejects every sign-in as "cancelled" before the user has even consented. The viewer now serves the redirect path as a small static page (`apps/viewer/public/oauth/msgraph/callback.html`, routed in dev by `apps/viewer/vite-plugins/oauth-callback.ts` and in production by a `vercel.json` rewrite) instead of letting the SPA fallback boot a second copy of the whole application inside the popup.
  
  Because that failure is a property of the popup being cross-origin rather than of any one provider, the waiting side ships as `waitForOAuthCallback` (plus the `OAUTH_CALLBACK_CHANNEL` name and its `OAuthCallbackMessage` shape) in `@ifc-lite/oauth-pkce`, so every provider built on that package shares one implementation. Messages are routed by the sign-in attempt's `state`, which is what keeps two concurrent sign-ins from completing each other's flow; `parseAuthorizationCallback` still performs the authoritative CSRF check. One consequence is deliberate: cancellation is no longer detectable, because `popup.closed` is the only signal a browser gives for it and that is exactly what COOP made unusable, so closing the popup now waits out the timeout.

### Patch Changes

- Updated dependencies [[`79105ff`](https://github.com/LTplus-AG/ifc-lite/commit/79105ff1e8a24a4d3e018595f026769813a0217d), [`c706f34`](https://github.com/LTplus-AG/ifc-lite/commit/c706f3452df4ab64a17966d5e965cf6518ccd417)]:
  - @ifc-lite/oauth-pkce@0.2.0
