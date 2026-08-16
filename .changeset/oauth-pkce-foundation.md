---
'@ifc-lite/oauth-pkce': minor
---

Add `@ifc-lite/oauth-pkce`: browser OAuth 2.0 Authorization Code + PKCE (RFC 7636) for a public client (no client secret). Provides PKCE code_verifier/code_challenge generation via Web Crypto, authorization-URL construction with CSRF `state` validation and redirect-origin validation, authorization-code and refresh-token exchange, and a `TokenManager` that persists tokens behind a caller-supplied storage interface and de-duplicates concurrent refreshes onto a single in-flight request.

This is shared plumbing for upcoming OAuth-based file-source providers (Google Drive, Dropbox, SharePoint/OneDrive); it does not implement or register any provider itself.

`@ifc-lite/oauth-pkce` 0.1.0 was published manually to establish the package and its OIDC trusted publisher, so this release is 0.2.0. Relative to 0.1.0 it corrects the `AuthorizationRequestConfig.extraParams` docstring (the extras are applied *first* and then overwritten by the protocol parameters — the previous "Applied last" described the opposite mechanism, though the override protection it promised was and is real), and makes `TokenManager` validate the shape of a persisted token entry before using it, so a corrupt or truncated entry is reported as "no session" instead of producing an `Authorization: Bearer undefined` request.
