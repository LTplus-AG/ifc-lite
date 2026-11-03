# buildagil openCDE API — findings & implementation

Status: implemented. Shown live on 2026-11-02 with a signed-in buildagil account: documents source sign-in, browsing and opening a model on `localhost:5000`, and the BCF topic API measured directly (reads and writes in a test project). Pulling and publishing BCF topics from the running viewer is not yet shown. Code: `server/sources/buildagil-*.ts` + `api/buildagil.ts` (relay), `packages/source-buildagil` (provider). The viewer offers the source only when `VITE_BUILDAGIL_CLIENT_ID` is set.

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
- **Auth:** `/foundation/1.0/auth` → `oauth2_auth_url` `https://openapi.buildagil.com/oauth2/authorize`, `oauth2_token_url` `https://openapi.buildagil.com/oauth2/token`, flows `authorization_code_grant`, `implicit_grant`, `client_credentials_grant`, no HTTP Basic. The authorize URL answers `303` to `login.microsoftonline.com/<buildagil tenant>/oauth2/v2.0/authorize`, passing the query through: buildagil fronts Microsoft Entra ID. Spec scopes: `openid`, `offline_access`, `api`; the authorize redirect rewrites `api` to `https://buildagil.sharepoint.com/.default`. Client ids come from buildagil support against registered callback URLs.
- **CORS only for allowlisted origins.** On 2026-10-30 `OPTIONS` on the API and the token endpoint answered `404`, and even `GET /foundation/versions` carried no `Access-Control-Allow-Origin`. buildagil then added `https://www.ifclite.com`: since 2026-11-02, preflights from it answer `200` with that origin, `authorization,content-type` and the route's method. Other origins (previews, `localhost`) still get no CORS headers, so the viewer keeps one same-origin relay for every origin.

## From buildagil support (2026-11-02)

- A client was created for IFClite with both callbacks (`https://www.ifclite.com/oauth/bcf/callback`, `http://localhost:5000/oauth/bcf/callback`). A client id was issued and no secret: a public client.
- PKCE and refresh tokens are supported. Large files are supported.
- There is no direct paging; page with `$top` and a date `$filter`, which is what the scan does.
- "High" BCF compatibility; the documented differences below stand until measured.
- A test project was provided for uploading test files.
- **Not a BCF 2.1 server.** `/1.0/auth` and `/1.0/current-user` → `404` (the `/1.0/projects` route answers `401`). The generic BCF connector (`/{version}/auth`, `current-user`) therefore cannot connect to it unchanged.
- **Document model:** `guid`, `filename`, `file_type` (extension, e.g. `pdf`), `folder_url` (path under `/documents`), `version_index`, `version_number`, dates, authors, `size_in_bytes`, `status`, labels, `link`. There is no folder endpoint; folders exist only as document paths. The list has `$top` (default 100) but no `$skip`.

## Design

- **Sign-in in the source, not the BCF connection.** The provider implements interactive auth (PKCE popup, `@ifc-lite/oauth-pkce` `TokenManager` in `ctx.storage`). It returns to the viewer's generic `/oauth/bcf/callback` page, the callback registered with buildagil. A buildagil session does not occupy the viewer's single BCF connection, so a BIMcollab BCF connection and a buildagil documents session can coexist.
- **One relay, declared in the manifest.** `permissions.relay` maps `https://openapi.buildagil.com` to `/api/buildagil`, so the provider names real URLs and the host rewrites them (as for Dalux). `api/buildagil.ts` has two route families:
  - `oauth2/token`: standard form grants (`authorization_code` with PKCE verifier and a registered `redirect_uri`, or `refresh_token`), exact field sets, this deployment's `client_id`, allowlisted `Origin`, same-origin `Sec-Fetch-Site`, posted to the one fixed token URL without following redirects. For the public client the grant is forwarded as is, without an `Origin`: buildagil's gateway answers a token request from an origin it has not allowlisted (`http://localhost:5000`, measured 2026-11-02) with an empty `200`, while one with no `Origin` reaches Entra. A deployment holding a confidential client sets `BUILDAGIL_CLIENT_SECRET` and the relay adds it. The upstream half is shared with the BIMcollab BCF token relay (`server/shared/oauth-token-forward.ts`).
  - `1.0/…`: enumerated reads (documents, projects, extensions, topics, comments, viewpoints and their parts), `POST 1.0/search`, and the topic writes: `POST` topics, comments and viewpoints, `PUT` topic. Search, topic and comment bodies are capped at 64 KiB, viewpoint bodies at 16 MiB; writes need an allowlisted Origin and JSON and never follow redirects. Caller bearer required, query keys allowlisted per route, header allowlists both ways, no cookies, streamed downloads. The bearer goes only to `openapi.buildagil.com`. A download redirected to `*.blob.core.windows.net` is followed without it; an Entra login redirect becomes `401`.
- **Folders from one scan.** IFC documents are listed with a `file_type` filter (both cases) and paged by `creation_date` (`ge` the last seen, deduplicated by guid), which never changes mid-scan. The folder tree is derived from their paths (`flat-subtree`), cached for a minute, capped at 5000 documents.
- **Revisions** are `version_index`; a named revision downloads exactly that version.

## To verify with a live account

1. Token refresh after expiry through the relay (the code exchange works server to server with no secret and no `Origin`, shown live), and how long tokens live.
2. `file_type` values beyond the lower-case extensions seen so far (the scan filters both cases). The date literal is settled: quoted and unquoted ISO timestamps both work (measured on topics).
3. Whether `$top` above 100 is honoured or capped. The scan uses 100, so it is correct either way, at the cost of more requests.
4. Document content: direct bytes or a redirect to blob storage, and large models through the edge relay (support: large files are supported upstream).
5. Search result shape for documents, and whether `folder_url` is present on hits.


## BCF topics, measured live (2026-11-02, test project, signed-in account)

- **Token:** an Entra access token for SharePoint (`aud` SharePoint, `scp` `AllSites.Write`) with `oid`, `name`, `upn` and `email`; the BCF connection names the account from those claims.
- **Topic list:** `$skip` is ignored (`$skip=1` returns the same topics); `$filter` on `modified_date` / `creation_date` works with quoted and unquoted ISO literals (a future date returns none); `$orderby` and `$top` work; `$expand=comments` works. Timestamps are second-precision (`2026-11-02T06:43:37Z`), so date paging must de-duplicate ties.
- **Topic update:** `PUT` works (200) as well as the documented `PATCH`.
- **Topic types:** `topic_type` must be one of the project's extension values (`Task`, `Model Issue`, `Documentation Log`, `Incident Log`, `Deficiency Log`, `Topic`, `Information`, `Decision`); there is no `Clash` or `Issue`.
- **Status rule:** only `Task`, `Model Issue`, `Documentation Log`, `Incident Log` and `Deficiency Log` keep a `topic_status` (`Draft`/`Open`/`Closed`). Any other type (e.g. `Information`) created with `topic_status: Open` is accepted (201) and stored with `topic_status: null`, silently. Each listed topic carries the statuses it allows in `authorization.topic_status`, but nothing states the rule per type up front, so the profile carries it as data (`topicStatusTypes`).
- **Comments:** a new comment is only its text; a `viewpoint_guid` sent with it is accepted (201) and discarded. Comments list newest first; your own comments can be deleted.
- **Viewpoints:** camera, `components` (selection, colouring, visibility) and a base64 PNG snapshot round-trip; the parts come back from `…/selection`, `…/coloring`, `…/visibility`, and `…/snapshot` as `image/png`. `aspect_ratio` 1.6 came back as 1, and selection keeps only `ifc_guid`.
- **Topics cannot be deleted** through the API (no `DELETE`).

The viewer connects to it as a BCF server through a profile (`apps/viewer/src/services/bcf-server-profiles.ts`): fixed sign-in endpoints instead of `/1.0/auth`, version `1.0`, identity from the token, every request through `/api/buildagil`, and `topicPaging: 'modified-date'` (`@ifc-lite/bcf-api`).

## Follow-ups

- **Publishing topics** from the viewer: done. A draft type the project lacks (`Clash`) is mapped to a type the coordinator picks in the publish panel (`Model Issue` preselected); a status the chosen type cannot keep is withheld and shown as a pre-check warning; the update baseline is the server's echo, so a nulled status is no false conflict; an uncertain create is checked with `modified_date` paging. Comments go out as text only, so the discarded `viewpoint_guid` costs nothing. Still open: snapshots stay small (Vercel caps request bodies at about 4 MB).
- **One buildagil session** for the documents source and the BCF connection, instead of two sign-ins.
- **Save back:** `PUT …/documents/{guid}` (new version) and `POST …/documents` behind the project's `createDocument` / document `updateContent` permissions.
- **Change detection:** the `documents.content_updated` webhook needs a server endpoint; polling `modified_date` is the browser-only alternative.
