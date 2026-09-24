---
'@ifc-lite/bcf-api': patch
---

Refactor: `BcfApiClient` now extends the new `@ifc-lite/opencde-foundation`'s `FoundationApiClient`, and BCF's OAuth2 token exchange, dynamic client registration, base-URL normalization/retry, and error types are that package's implementation, reached here under their historical BCF names (`normalizeBcfBaseUrl`, `registerBcfClient`, `BcfApiError`, `BcfAuthenticationError`, ...). `BcfApiError` and `BcfAuthenticationError` are thin subclasses of the Foundation errors, so a directly constructed BCF error is named as before too. No change to `@ifc-lite/bcf-api`'s public API or behaviour. Errors still report `name` as `BcfApiError` / `BcfAuthenticationError`, and `BcfApiVersion` and `getVersions(): Promise<BcfApiVersion[]>` keep their `{ version_id, detailed_version? }` shape. The OAuth2 functions are thin wrappers over the Foundation ones.
