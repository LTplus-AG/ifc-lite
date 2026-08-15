---
'@ifc-lite/oauth-pkce': minor
---

Add `@ifc-lite/oauth-pkce`: browser OAuth 2.0 Authorization Code + PKCE (RFC 7636) for a public client (no client secret). Provides PKCE code_verifier/code_challenge generation via Web Crypto, authorization-URL construction with CSRF `state` validation and redirect-origin validation, authorization-code and refresh-token exchange, and a `TokenManager` that persists tokens behind a caller-supplied storage interface and de-duplicates concurrent refreshes onto a single in-flight request.

This is shared plumbing for upcoming OAuth-based file-source providers (Google Drive, Dropbox, SharePoint/OneDrive); it does not implement or register any provider itself.
