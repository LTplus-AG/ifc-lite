---
'@ifc-lite/source-commit-http': minor
---

New package: a generic commit-aware file-source provider over a documented REST contract, so a commit service can plug into IFClite without a bespoke provider. OIDC authorization code + PKCE with endpoint discovery, `GET /capabilities` negotiation, multipart commit upload with `Idempotency-Key`, and the contract's error codes mapped from both JSON bodies and bare HTTP statuses. Tested by running `runCommitConformanceSuite` against a mocked service backed by the fixture provider.
