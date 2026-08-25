# @ifc-lite/source-msgraph

## 0.2.1

### Patch Changes

- [#3031](https://github.com/LTplus-AG/ifc-lite/pull/3031) [`66f3969`](https://github.com/LTplus-AG/ifc-lite/commit/66f39693ce006a43efb2c156e4f5f8f95f1d1606) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `clampPageSize` sending Graph a literal `$top=0` for a fractional sub-1 `limit`.
  
  A `ListOptions.limit` between 0 and 1 (e.g. `0.5`) passed the function's `limit > 0` guard but then floored to `0` with no lower bound, producing a `$top=0` query parameter instead of "use at least one item". `source-dropbox`'s own `clampPageSize` already floors at 1 for the same case (and has a test pinning it); `source-msgraph`'s did not. Added the same `Math.max(1, ...)` floor, plus a `clampPageSize` test block and a real cross-page-boundary `listFiles` pagination test (mirroring `source-dropbox/test/provider.test.ts`'s own pagination test), which passed on the first correct run - no pagination bug found, just a coverage gap.

- [#3031](https://github.com/LTplus-AG/ifc-lite/pull/3031) [`66f3969`](https://github.com/LTplus-AG/ifc-lite/commit/66f39693ce006a43efb2c156e4f5f8f95f1d1606) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `signOut()` resurrecting a signed-out session when a token refresh is already in flight.
  
  `msGraphAuth.signOut` built one `TokenManager` from freshly-read `clientId`/`tenant` preferences and cleared only that instance. `TokenManager`'s refresh-race protections are all per-instance, so if either preference changed (or was cleared) between when the manager actually holding an in-flight refresh was created and when `signOut` ran, `signOut` would clear a *different* cached manager - leaving the real one's refresh free to write a valid token set back to storage right after sign-out deleted it. The user would appear signed out, then be silently signed back into the account they explicitly disconnected on the next mount.
  
  `source-dropbox`'s `signOut` already guards this exact shape (`[#2635](https://github.com/LTplus-AG/ifc-lite/issues/2635)`): it clears every cached `TokenManager`, not just the one the current preferences name. `source-msgraph` now does the same - `signOut()` iterates `managerCache.values()` and clears each one before resetting the cache.
  
  `test/refresh-race.test.ts` gains a case reproducing the race (clientId cleared mid-flight, mirroring `source-dropbox/test/refresh-race.test.ts`'s scenario) and asserting storage stays clean after sign-out.

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
