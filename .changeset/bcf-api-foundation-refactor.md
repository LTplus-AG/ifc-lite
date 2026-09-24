---
'@ifc-lite/bcf-api': patch
---

Refactor: `BcfApiClient` now extends the new `@ifc-lite/opencde-foundation`'s `FoundationApiClient`, and BCF's OAuth2 token exchange, dynamic client registration, base-URL normalization/retry, and error types are that package's implementation, re-exported here under their historical BCF names (`normalizeBcfBaseUrl`, `registerBcfClient`, `BcfApiError`, `BcfAuthenticationError`, ...). No change to `@ifc-lite/bcf-api`'s public API or behaviour. Errors still report `name` as `BcfApiError` / `BcfAuthenticationError`, and `BcfApiVersion` keeps its own `{ version_id, detailed_version? }` shape.
