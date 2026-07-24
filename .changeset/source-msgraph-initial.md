---
"@ifc-lite/source-msgraph": minor
---

Adds `@ifc-lite/source-msgraph`, a SharePoint and OneDrive file-source provider
built on the v2 plugin contract, and the second reference implementation of it.

Signs in with MSAL (authorization code + PKCE, popup only — a full-page redirect
would discard a loaded model), browses sites, document libraries and folders one
level at a time with `@odata.nextLink` cursors, reads version history, and
detects changes through Graph's `delta` endpoint.

Downloads go through `@microsoft.graph.downloadUrl` rather than `/items/{id}/content`,
which returns a 302 that a browser cannot follow when an `Authorization` header
forces a CORS preflight. That URL is pre-signed on a tenant-specific host and is
invalidated by sending an `Authorization` header at all, so it is fetched via
`ctx.fetchPublic`.

Bring your own Entra app registration: the client id and authority are
preferences, and the client id is a public identifier rather than a secret.
