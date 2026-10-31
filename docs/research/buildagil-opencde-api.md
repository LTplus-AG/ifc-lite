# buildagil openCDE API — findings & implementation

Status: implemented, not yet verified against a live account (2026-10-30). Code: `server/sources/buildagil-*.ts` + `api/buildagil.ts` (relay), `packages/source-buildagil` (provider). The viewer offers the source only when `VITE_BUILDAGIL_CLIENT_ID` is set.

## What the API is

buildagil publishes an "openCDE API" based on buildingSMART's BCF and Documents APIs, extended with its own endpoints ([knowledge base](https://knowledge.buildagil.com/en/article/odul8z), OpenAPI document "buildagil openCDE API" 1.0 on SwaggerHub, modified 2026-10-27). One production host, no test environment.

| Area | Endpoints |
|---|---|
| Discovery | `GET /foundation/versions`, `GET /foundation/1.0/auth` |
| Projects | `GET /1.0/projects`, `/1.0/projects/{id}`, `/extensions`, `/users` |
| Documents | `GET /1.0/projects/{id}/documents` (`$filter`, `$orderby`, `$top`), content `GET …/documents/{guid}`, `…/metadata`, `…/versions`, version content `…/versions/{index}`; writes: `POST …/documents?filename=&folder_url=` (raw body), `PUT …/documents/{guid}` (new version), `PATCH …/metadata`, `POST …/move` |
| Search | `POST /1.0/search` (`targets`, `search_text`/`query_text`, `project_ids`, per-target `filters`, `limit` ≤ 200, `offset` ≤ 50000) |
| Topics | BCF-like topics, comments, viewpoints (BCF 3.0 viewpoint shape), checkpoints, attachments, document references |
| Other | meetings, milestones, personal topics, webhook subscriptions (`documents.created`, `documents.content_updated`, …) |

## Verified facts (unauthenticated probes, 2026-10-30)

- **Discovery:** `GET https://api.buildagil.com/foundation/versions` → `foundation 1.0` at `https://openapi.buildagil.com/foundation`, `bcf 3.0` at `https://openapi.buildagil.com/1.0`, `documents 1.0` at `https://openapi.buildagil.com/documents/1.0`. `api.buildagil.com` is retired on 2026-12-31 in favour of `openapi.buildagil.com`.
- **Auth:** `/foundation/1.0/auth` → `oauth2_auth_url` `https://openapi.buildagil.com/oauth2/authorize`, `oauth2_token_url` `https://openapi.buildagil.com/oauth2/token`, flows `authorization_code_grant`, `implicit_grant`, `client_credentials_grant`, no HTTP Basic. The authorize URL answers `303` to `login.microsoftonline.com/<buildagil tenant>/oauth2/v2.0/authorize`, passing the query through: buildagil fronts Microsoft Entra ID. Spec scopes: `openid`, `offline_access`, `api`. Client id and secret come from buildagil support against registered callback URLs.
- **No CORS anywhere.** `OPTIONS` on the API and on the token endpoint → `404`; even `GET /foundation/versions` carries no `Access-Control-Allow-Origin`. A browser can reach neither the API nor the token endpoint, so both go through a same-origin relay.
- **Not a BCF 2.1 server.** `/1.0/auth` and `/1.0/current-user` → `404` (the `/1.0/projects` route answers `401`). The generic BCF connector (`/{version}/auth`, `current-user`) therefore cannot connect to it unchanged.
- **Document model:** `guid`, `filename`, `file_type` (extension, e.g. `pdf`), `folder_url` (path under `/documents`), `version_index`, `version_number`, dates, authors, `size_in_bytes`, `status`, labels, `link`. There is no folder endpoint; folders exist only as document paths. The list has `$top` (default 100) but no `$skip`.

## Design

- **Sign-in in the source, not the BCF connection.** The provider implements interactive auth (PKCE popup, `@ifc-lite/oauth-pkce` `TokenManager` in `ctx.storage`). It returns to the viewer's generic `/oauth/bcf/callback` page, the callback registered with buildagil. A buildagil session does not occupy the viewer's single BCF connection, so a BIMcollab BCF connection and a buildagil documents session can coexist.
- **One relay, declared in the manifest.** `permissions.relay` maps `https://openapi.buildagil.com` to `/api/buildagil`, so the provider names real URLs and the host rewrites them (as for Dalux). `api/buildagil.ts` has two route families:
  - `oauth2/token`: standard form grants (`authorization_code` with PKCE verifier and a registered `redirect_uri`, or `refresh_token`), exact field sets, this deployment's `client_id`, allowlisted `Origin`, same-origin `Sec-Fetch-Site`. The relay adds `client_secret` and posts to the one fixed token URL without following redirects. The upstream half is shared with the BIMcollab BCF token relay (`server/shared/oauth-token-forward.ts`).
  - `1.0/…`: enumerated reads plus `POST 1.0/search`, caller bearer required, query keys allowlisted per route, header allowlists both ways, no cookies, streamed downloads. The bearer goes only to `openapi.buildagil.com`. A download redirected to `*.blob.core.windows.net` is followed without it; an Entra login redirect becomes `401`.
- **Folders from one scan.** IFC documents are listed with a `file_type` filter (both cases) and paged by `creation_date` (`ge` the last seen, deduplicated by guid), which never changes mid-scan. The folder tree is derived from their paths (`flat-subtree`), cached for a minute, capped at 5000 documents.
- **Revisions** are `version_index`; a named revision downloads exactly that version.

## To verify with a live account

1. Token exchange and refresh through the relay (PKCE accepted alongside the secret? refresh tokens issued for `offline_access`? lifetimes).
2. Access-token claims: is it an Entra JWT with `oid` / `name` / `preferred_username`, or buildagil's own token?
3. `file_type` values (case, dot) and the OData literal format for `creation_date ge …` (unquoted ISO 8601 assumed).
4. Whether `$top` above 100 is honoured or capped. The scan uses 100, so it is correct either way, at the cost of more requests.
5. Document content: direct bytes or a redirect to blob storage; size limits for large models through the edge relay.
6. Search result shape for documents, and whether `folder_url` is present on hits.

Questions 1, 5 and the BCF compatibility of topics were sent to buildagil support with the credential request.

## Follow-ups

- **BCF topics.** The topic, comment and viewpoint endpoints follow BCF 3.0's shapes under `/1.0/…` but differ: fixed `topic_type` / `topic_status` enums, comments without `viewpoint_guid`, no `auth` / `current-user`. A buildagil BCF connection would reuse this provider's session and relay (adding the topic routes) with a BCF client configured for those differences.
- **Save back:** `PUT …/documents/{guid}` (new version) and `POST …/documents` behind the project's `createDocument` / document `updateContent` permissions.
- **Change detection:** the `documents.content_updated` webhook needs a server endpoint; polling `modified_date` is the browser-only alternative.
