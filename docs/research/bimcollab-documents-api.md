# BIMcollab Documents API — spike & implementation plan

Status: shipped (2026-10-29). Code: `server/sources/bimcollab-relay*.ts` + `api/bimcollab.ts` (relay), `packages/source-bimcollab` (provider), `apps/viewer/src/services/sources/bimcollab-source.ts` (viewer binding). On by default; `VITE_SOURCE_BIMCOLLAB=false` removes it.

## What the API is

BimCollabPublicApi v1 ([swagger](https://api.eu.bimcollab.com/BimCollabPublicApi/v1/swagger/BimCollabPublicApi-v1.swagger.json)), 50 operations under `/documents/v1/…`:

| Area | Endpoints |
|---|---|
| Navigation | `project-structure` (locations → projects → phases), `projects`, `project-phases`, `document-sets`, `spatial-structure-elements` |
| Documents | list per project/phase (`searchText`, `newVersionSinceDateTime`, `publishedOnly`, `documentSetId`, discipline/label filters, `limit`/`offset`), get by id / by number, `PATCH` metadata |
| Versions | list per document / project / phase / storey, get, `PATCH` metadata |
| Download | `documents/{id}/download` (latest), `document-versions/{id}/download` → `{ downloadUrl, fileName }` (pre-signed blob URL) |
| Upload | `…/upload-tokens` → `{ preSignedUploadUrl, blobName }`; PUT file to the URL; then `PUT …/documents` (new document) or `PUT documents/{id}/document-versions` (new version) |
| IFC links | `linked-documents?ifcGuid=` — documents linked to an IFC object |
| To-dos (read) | tasks, questions, reviews, revisions, notes, notifications, audit tasks |
| Space lists | companies, disciplines, labels, custom fields, instance states |

## Verified facts

- **Auth is the BCF token.** Security scheme `bcfBearer`; BIMcollab docs: "Both APIs use the same sign-in process", scope `openid offline_access bcf`. Our BIMcollab preset already requests that scope, so an existing BCF session should work without a second sign-in.
- **Base URL:** `https://api.eu.bimcollab.com/spaces/<space-guid>/documents/v1/…`. The un-prefixed swagger path (with `bimcollab-space-guid` header only) returns 502; the `/spaces/<id>/` form returns 401 without a token. The client sends both.
- **Space GUID** is a claim in the access token (BIMcollab: "stored inside your access token"); the claim name is not documented.
- **CORS:** preflight on `/spaces/<id>/documents/v1/projects` from a foreign origin with `authorization` → `204`, `access-control-allow-origin: *`. The browser can call the API directly; no proxy needed for JSON calls.
- **Downloads are two hops:** an API call, then an unauthenticated fetch of the pre-signed URL. The token must not go to blob storage.

## Phase 0 results (2026-10-29, Playground, PlayGround_Client, real user login)

- **Space claim: `spaceGuid`** (`8e3136c4-…`, matches the Playground space). Token `aud` is just `bcf`. There is no separate Documents audience, so any BIMcollab BCF token (including our production app's) has the right shape.
- Other claims: `client_id`, `role` (`User`), `subscriptionPlan` (`Ultimate`), `idp`, `email`, `sub`.
- **BCF Connection API with the same token: 200** (`/bcf/2.1/projects` → 1 project).
- **Documents API: 403 with an empty body on every endpoint**, including space-wide lists (`/companies`, `/labels`, `/projects`, `/project-structure`), with or without the `bimcollab-space-guid` header. BIMcollab's guide defines 403 as "user account doesn't have permission for this space/project". The account is a BCF member but has no document-management access in the space. The token is accepted (not 401); authorization is per user.
- The un-prefixed swagger path form returns 502 even with a token. Only `/spaces/<id>/documents/v1` works.
- **Still open:** blob CORS and the download flow (blocked by the 403), and regions. To unblock, BIMcollab needs to give the developer account document-management access to a Playground project, or we test on a real space where the user has documents.

Consequences for the design: a 403 is an expected state, not an error. Show it as "Your BIMcollab account has no document access in this space". Hide the "Open from BIMcollab" entry after a 403 on `/project-structure`.

## Phase 0 results — real space (busa.bimcollab.com, 2026-10-29, IFClite production app via www.ifclite.com)

- **The production app's token works for Documents.** Same `spaceGuid` claim (`728fc6a4-…`), `aud: bcf`, issued through the token relay. `project-structure`, `project-phases`, `companies`, project documents, `document-sets`, document and version GET all return 200.
- **Data:** 1 project ("BUSA Herisau", no phases), 15 documents, all `.ifczip`, `documentType: Model`, `publishState: Shared`, 1 version each. `latestVersion.url` is empty. The viewer must accept `.ifczip`.
- **BLOCKER 1 — the browser cannot call the API.** The CORS preflight returns `204` and `access-control-allow-origin: *` but **no `Access-Control-Allow-Headers`**, so Chrome refuses any request carrying `Authorization` (`TypeError: Failed to fetch`; the same request without a token reaches the API and gets 401). Verified in Chrome 156 from `https://www.ifclite.com`. A wildcard origin would not help anyway, because `Authorization` is never covered by `*`. **Fix on our side: a server-side proxy** (Vercel function + Vite dev plugin, like `bcf-token-relay`): `/api/bimcollab/documents/<spaceGuid>/<path>` → `https://api.eu.bimcollab.com/spaces/<spaceGuid>/documents/v1/<path>`. It forwards the caller's bearer, allowlists the host and path prefix, has no cache and no logging of headers, and limits methods (GET now; PUT/POST/PATCH for Phase 3). Also ask BIMcollab to send `Access-Control-Allow-Headers: authorization, content-type, bimcollab-space-guid`; then the proxy can be removed.
- **BLOCKER 2 — downloads return 404 `"No download URL available for this document"`** for all 15 documents, on both `documents/{id}/download` and `document-versions/{id}/download`, even though both records load. Not a permission error (that would be 403). Likely causes: files stored in a way the API can't presign yet (e.g. `.ifczip` or uploads made before the API launched), or a space-side setting. **Ask BIMcollab.** Until that's answered we can't confirm that downloads work end to end or whether storage allows CORS.
- `linked-documents` without `ifcGuid` → 400 (the parameter is effectively required).
- `api.us.bimcollab.com` has no valid TLS certificate (the host doesn't exist in that form). `api.bimcollab.com` → 404. The EU host serves this Swiss space; other regions are still unknown.

### Revised design

- `BimcollabDocumentsClient` takes a `baseUrl`: the proxy in the browser, the direct host in Node/CLI/MCP, where CORS doesn't apply. The spike already isolates the base; this needs a small refactor.
- The direct-download path stays as designed (presigned URL, no bearer). Storage CORS is still unverified; if it's blocked, the proxy also streams the file.

## Unverified (needs a real BIMcollab login)

1. ~~Claim name for the space GUID~~ — resolved: `spaceGuid`.
2. **CORS on the pre-signed download URL** (Azure Blob-style SAS?). If storage does not send ACAO for our origin, the download needs a streaming relay, like `bcf-token-relay`, limited to BIMcollab storage hosts.
3. **Entitlement:** the audience is fine (`bcf`); access is per user's document-management membership (403 otherwise). Not yet seen succeed.
4. **Regions:** only `api.eu` is documented. US or other spaces may use another host. The client takes `apiHost`; the mapping is unknown.
5. **Shape of `GetLinkedDocumentResponse`** (empty schema in swagger).

Steps 1–3 come first in the plan. Use the playground space (`playground.bimcollab.com`, space `8e3136c4-…`) or the production app on a real space. This takes one interactive sign-in by a person.

## Original implementation plan (superseded by "Production rollout" below)

### Phase 0 — Live verification (½ day, needs a human sign-in)
- Sign in with the BIMcollab preset in a dev build. Decode the token and record the space claim. Call `project-structure`, list documents, download one IFC from the browser.
- Record answers to the five questions above. Update the claim lookup and decide whether a download relay is needed.

### Phase 1 — Service layer (viewer)
- Promote `bimcollab-documents.ts` from spike: tighten the space claim to the confirmed name and keep the scan as a fallback.
- Extract the token-provider and 401-retry logic from `createConnectedClient()` in `bcf-server.ts` into `createConnectedTokenSource()`. Then the Documents client reuses refresh single-flight, account binding and relay without duplicating them.
- `connectedDocumentsClient()`: returns `null` unless the saved connection is BIMcollab (`isBimcollabServerUrl`) and a space id resolves. Store `spaceId` and `apiHost` on `BcfServerConfig` (sanitize defaults to `''`).
- Map 401/403 to a clear UI state, e.g. "Documents not enabled for this space or app".
- Download relay, only if Phase 0 shows no CORS. Add a Vercel and Vite route `/api/bimcollab/download?url=` that allowlists BIMcollab storage hosts, streams the response, and never accepts bearer tokens.

### Phase 2 — "Open from BIMcollab" UI
- Entry point in the file-open menu / home view, shown when a BIMcollab connection exists; otherwise it links to the BCF connect dialog.
- Picker: location → project → phase tree (one `project-structure` call). Then a document list filtered to models (`documentType=Model` or IFC extensions), with search and a version dropdown (`listVersions`).
- Open: `downloadFile()` → existing `useIfcLoader().loadFile(file, target)`. Primary or federated targets work unchanged. Show progress (stream the body with `Content-Length` for a progress bar) and support cancel (`AbortSignal`).
- Record provenance on the loaded model: `{ source: 'bimcollab', spaceId, documentId, documentVersionId, versionNumber }`. Phase 3 and "check for newer version" use it.
- Recent files: store a BIMcollab reference, not bytes. Re-opening fetches again, behind auth.
- i18n strings across all locales, and a tour step.

### Phase 3 — Write-back and cross-links (separate PRs)
- **Upload new version** of the opened document after edits or export: upload-token → PUT blob (no bearer) → `PUT documents/{id}/document-versions` with `fileName`, `versionNumber`, `versionDate`. Needs explicit user confirmation and the metadata form (number/date required). Check pre-signed PUT CORS in Phase 0 as well.
- **Publish reports** (IDS/clash results, BCF zip) as new documents. `UploadDocumentToProject` requires `documentNumber`, `documentDate`, `manufacturerId` (a company from `/companies`).
- **Selection → linked documents:** `linked-documents?ifcGuid=` for the selected element's GlobalId, shown in the properties panel.
- **Freshness:** poll `newVersionSinceDateTime` for the opened document and show "newer version available".
- SDK/MCP/CLI exposure (`ifc-lite bimcollab open|pull`) once the viewer path is stable. Move the client into a package (e.g. next to `@ifc-lite/bcf-api`) at that point, not before.

### Tests
- Unit: the client (done in the spike), config sanitize migration, token-source extraction (re-run the existing `bcf-server.test.ts` refresh/account-binding suites against the shared helper).
- Integration: a fake Documents server next to `src/test/bcf-http-server.ts`, covering structure → list → version → download → `loadFile`.
- Manual or e2e against the playground for the Phase 0 facts. Keep this out of CI (needs an interactive login).

### Risks
- Production client id may not be entitled to Documents. Raise with BIMcollab early, alongside Phase 0.
- Large IFCs, hundreds of MB, are fully buffered as a `File`. Acceptable for v1 (same as local open), but stream to OPFS later if memory becomes a problem.
- Confidential documents (`includeConfidential`): exclude by default.

## Download workaround research (2026-10-29, busa)

- The 15 models are `documentInstanceSource: DirectUpload` with description "uploaded from WebViewer", `allowDownload: true`, `modelSyncEnabled: true`. The web app downloads them fine, so the public `/download` 404 is a **BIMcollab API gap** for these files, not a permission issue.
- The web app's download link `GET https://<space>.bimcollab.com/documents/da/location/<n>/project/<n>/documentinstance/download/<versionNumericId>` **accepts our OAuth bearer token** and streams the file (`200 application/octet-stream`, `content-disposition` filename, `PK…` zip; 10 MB in 0.7 s, TTFB 0.4 s, chunked, no `Content-Length`). Location and project segments are ignored (`location/0/project/0` works); the numeric version id is required (the GUID form returns 404). No token → 302 to login.
- Numeric ids come from the web app's `POST /documents/api/documentapi/getdocuments` (DataTables body; `locationId` is required, `projectId` optional; also accepts the bearer). `data[].latestVersion.id` is the numeric version id. Public ↔ internal records match **15/15 uniquely on `documentNumber` + `versionNumber`**.
- CORS: `busa.bimcollab.com/bcf/2.1/*` answers preflights per origin (`allow-origin: https://www.ifclite.com`, `allow-headers: authorization`), which is why BCF works in the viewer today. `/documents/...` internal routes answer preflight with 405, and `api.eu` sends no allow-headers, so both go through the relay.
- The viewer already opens `.ifczip` (`supported-model-files.ts`).
- These internal routes are **undocumented**. Use them only as a fallback when the public `/download` returns 404, behind a feature flag, and report the gap to BIMcollab so the fallback can be removed.

## Production rollout (fast path)

Target: "Open from cloud → BIMcollab" in production within about a week. Three PRs, each shippable on its own.

### PR 1 — `bimcollab-relay` edge function (≈1 day)
Copy the `server/sources/dalux-relay.ts` design: `server/sources/bimcollab-relay.ts` + `api/bimcollab.ts` (edge) + `vercel.json` rewrite `/api/bimcollab/:path*` + Vite dev plugin + tests next to `tests/api/bcf-token-relay.test.ts`.
- Caller's `Authorization: Bearer` is mandatory; the relay holds no credentials. Origin allowlist, as in the token relay.
- Two upstream families, nothing else:
  1. `docs/<spaceGuid>/<path>` → `https://api.eu.bimcollab.com/spaces/<spaceGuid>/documents/v1/<path>`. GET only; path allowlist: `project-structure`, `projects`, `project-phases`, `projects/*/documents`, `project-phases/*/documents`, `documents/*`, `documents/*/document-versions`, `documents/*/download`, `document-versions/*`, `document-versions/*/download`.
  2. `space/<label>/…` → `https://<label>.bimcollab.com` (single DNS label, same validation as the token relay):
     - `GET space/<label>/download/<int>` → `/documents/da/location/0/project/0/documentinstance/download/<int>`, streamed. `content-disposition` and `content-type` are passed through.
     - `GET space/<label>/index?locationId=<int>&projectId=<int>` → the relay builds the fixed `getdocuments` POST body itself (no caller-supplied POST body) and returns only `{documentNumber, versionNumber, versionNumericId, allowDownload}`.
- Forward an explicit header allowlist only; never cookies. Refuse off-host redirects (the Dalux `redirect: 'manual'` pattern). Add a WAF rate-limit rule on `/api/bimcollab`.
- Later (Phase 3 uploads): add `POST …/upload-tokens` and `PUT …/documents|document-versions` to family 1. The presigned blob PUT goes directly to Azure, after checking blob CORS.

### PR 2 — `@ifc-lite/source-bimcollab` provider (≈2 days)
New package like `packages/source-dalux` (provider, http-client, mapping, manifest), registered in `apps/viewer/src/services/sources/registered-providers.ts`.
- `auth`: reuse the saved BIMcollab BCF session. Expose the token source from `bcf-server.ts` (refresh single-flight, account binding, token relay) through the host instead of a second sign-in. If there's no session, the provider's sign-in launches the existing BIMcollab OAuth flow.
- `listProjects` → `project-structure` (locations → projects). `listContainers` → project phases / document sets. `listFiles` → documents filtered to models (`documentType=Model` or IFC extensions). `listRevisions` → `document-versions`. `watchRevisions` → `newVersionSinceDateTime`. `searchFiles` → `searchText`.
- `download` → public `/download` presigned URL, fetched without the bearer. On **404 "No download URL available"**, fall back to the relay's `index` (match `documentNumber` + `versionNumber`) and then `download/<int>`. The numeric index is cached per project.
- Map 403 to "no document access in this space"; a 401 refreshes the token.
- Space id from the `spaceGuid` claim; space label from the BCF server URL host.

### PR 3 — polish (≈1 day, can trail)
i18n for all locales, a tour step, provenance on loaded models (`spaceGuid/documentId/versionId`), a "newer version available" badge via `watchRevisions`, and analytics events.

### Open items to clear in parallel (not blocking PR 1)
- **numeric `locationId`** for the fallback index: only `1` is known on busa. Confirm how to get it (try `locationId` from the web app's `/api/universe/projects/<n>` with a session, or iterate a small range server-side). Alternatively ask BIMcollab.
- **Email BIMcollab** (developer contact): (a) the public `/download` 404 for WebViewer/DirectUpload models; (b) ask them to add `Access-Control-Allow-Headers: authorization, content-type, bimcollab-space-guid` on `api.eu` for our origin, as they already do for `/bcf`; (c) region hosts for non-EU spaces. Each fix lets us delete relay code.
- **Presigned blob CORS** is unverified because no document has produced a presigned URL yet. Download through the relay if blocked; the provider can choose per response.

### Validation before merge
Unit tests for relay path validation (as for Dalux), plus provider tests against a fake server that reproduces the 404 → fallback path. Run `ifc-agent-ops profile ifc-typecheck` and the viewer tests through the fleet. Then do a manual end-to-end on busa: sign in → BIMcollab → BUSA Herisau → M-ARC-51 → opens. Vercel previews can't run this, because BIMcollab only registers `https://www.ifclite.com/oauth/bcf/callback` and `http://localhost:5000/oauth/bcf/callback`. Run it on `localhost:5000` (the Vite relay plugin plus `BCF_BIMCOLLAB_CLIENT_SECRET` in `.env.local`), then ship to production behind a flag (`VITE_SOURCE_BIMCOLLAB`) and verify there before enabling it by default.
