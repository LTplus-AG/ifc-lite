---
'@ifc-lite/opencde-foundation': minor
---

Add `@ifc-lite/opencde-foundation`: client for the buildingSMART OpenCDE Foundation API — the services and conventions every OpenCDE API (BCF, Documents, ...) shares. Provides `FoundationApiClient` (versioned `{baseUrl}/{version}` request plumbing, Bearer token injection, `/versions`, `/auth` and `/current-user`), `/foundation/versions`-based API discovery (`getFoundationVersions`, `findApiVersion`, `apiBaseUrlFor`), OAuth2 token exchange for the password, refresh, client-credentials and authorization-code grants plus dynamic client registration, and the `FoundationApiError`/`FoundationAuthenticationError` error types.

`@ifc-lite/bcf-api`'s `BcfApiClient` now extends `FoundationApiClient` and its OAuth2/discovery/error code is this package's, re-exported under its historical names — a refactor with no change to `@ifc-lite/bcf-api`'s public API or behaviour (see that package's own changeset).
