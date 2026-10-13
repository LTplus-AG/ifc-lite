# Reviewed model report service

A separate Node service for user-reviewed GitHub reports and optional confidential model uploads. It uses PostgreSQL for sessions, admission quotas, reports, agreements, multipart ownership, audit events and the GitHub outbox. S3 stores private model objects; model bytes travel directly from the browser to storage in 16 MiB parts. It does not reuse cloud-account tokens or collaboration room storage.

## Deployment

HTTP submissions remain queued-only. The issue transport and durable retry recovery code are present, but startup registers only retention and model verification. Restoring the GitHub publisher requires qualification of the complete publication path and a runtime witness. Do not deploy this layer as a rollback over the existing N deployment. New user submissions, NDA signing and public model sharing remain subject to their separate launch gates.

Required disclosure configuration: `REPORT_STORAGE_PROVIDER`, `REPORT_STORAGE_LOCATION`, and `REPORT_BACKUP_DISCLOSURE`. These describe actual deployment; Switzerland is the legal recipient jurisdiction, not an inferred hosting location.

Required server configuration: `REPORT_VIEWER_ORIGIN` (exact HTTPS origin), `REPORT_DATABASE_URL`, `REPORT_S3_BUCKET`, `REPORT_S3_REGION`, `REPORT_S3_ACCESS_KEY_ID`, `REPORT_S3_SECRET_ACCESS_KEY`, `REPORT_ADMISSION_SECRET` (random 32+ characters), `REPORT_ADMIN_TOKEN` (separate random 32+ characters), `REPORT_GITHUB_APP_ID`, `REPORT_GITHUB_INSTALLATION_ID`, exactly one of `REPORT_GITHUB_PRIVATE_KEY_FILE` or `REPORT_GITHUB_PRIVATE_KEY`, and `REPORT_GITHUB_REPOSITORY`. `PORT` defaults to 3005. Optional S3-compatible configuration: `REPORT_S3_ENDPOINT`, `REPORT_S3_FORCE_PATH_STYLE=true`.

The GitHub App must be installed only on the destination repository with Issues read/write permission. Credentials remain server-side. `GET /healthz` checks PostgreSQL. Startup applies additive tables. Run one initial replica; background jobs serialize upload mutation using database locks. Session creation serializes count-and-insert for each verified admission identity across replicas.

Configure a private bucket, block public access and anonymous listing, mandatory encryption, exact viewer-origin PUT CORS permitting `x-amz-checksum-sha256` and exposing ETag/checksum headers, and lifecycle abortion of incomplete multipart uploads after one day. Disable versioning or install version-aware deletion/lifecycle before promising deletion. No CDN or public bucket endpoint is used. Every provider uses the same verification path: a bounded server-side read of the completed object verifies every 16 MiB part against the immutable authorized SHA256 ledger and records the full-object SHA256. Completion queues verification and responds immediately; clients poll until ready. Missing ListParts checksums are represented as unverified metadata, never treated as proof. This costs one full object read and any provider read/egress fees per verification attempt; process restart may require another read. Verification has a 15-minute deadline and exact size cap. Never put model names in object keys or logs. Runtime IAM needs only multipart/list/put/head/get/delete on the dedicated bucket prefix.

Route `/api/reports/*` from the viewer's exact origin to this service before the SPA rewrite. Requests use secure HttpOnly SameSite cookies; mutations validate origin and CSRF. Do not expose administrator credentials to viewer builds, browser storage or query strings. Administrator access is an operational bearer API, not a shipped maintainer login UI; place it behind the organization's authenticated gateway. Tokens are compared in constant time and downloads/custom-agreement decisions audited.

Admission is durable across recreated browser sessions. Daily quotas apply to an HMAC of the verified client address. Forwarded headers are ignored unless the socket peer matches explicit `REPORT_TRUSTED_PROXY_CIDRS`; then the nearest untrusted hop is selected from right to left. Configure only actual ingress CIDRs and require ingress to append the observed peer; never trust all addresses. Without configured trusted ingress, proxy users conservatively share the socket-peer quota. Default limits: 20 reports and 4 GiB reserved upload bytes per peer/day, 100 GiB outstanding global storage, 2 GiB/model. Browser concurrency is two parts; presigned URLs expire after five minutes and are bound to exact part, size and SHA256. Replayed URLs can replace only the same checksummed part while its upload remains active.

## Confidentiality

Ordinary private upload consent permits only diagnosing and verifying the reported defect. Standard and custom NDA workflows are optional. For standard acceptance, set `REPORT_AGREEMENT_FILE`, `REPORT_AGREEMENT_VERSION`, and `REPORT_APPROVED_AGREEMENT_SHA256` only after the owner reviews and approves that exact text. Missing approval disables signing while reports and ordinary private uploads still work. A mismatched digest, draft marker or placeholder fails startup. The issuer is LTplus AG, Switzerland; hosting geography is a separate deployment fact. Accepted text version/digest, signer declarations, server date and PDF digest are retained. The PDF records electronic acceptance; it is not a qualified digital signature or verified identity claim. Approved signing additionally requires `REPORT_AGREEMENT_FONT_FILE`, a licensed Unicode font covering the approved text and supported signer names. The supplied Docker image includes DejaVu Sans at `/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf` and its package licence. Startup verifies template glyph coverage before enabling signing; the PDF embeds a subset. Unsupported signer characters are rejected clearly before acceptance, never replaced silently.

Custom agreements remain manual review requests. `GET /api/reports/admin/pending` lists the latest 100 reports; `GET /api/reports/admin/:id` retrieves private reviewed details and the custom agreement reference. Both require the configured maintainer bearer and are audited. `POST /api/reports/admin/:id/custom-nda` with authenticated administrator bearer and `{accepted:true,signedAgreementReference:"private document reference"}` records completed review and unlocks the requested upload. The service does not pretend a user-supplied document was automatically signed.

Private model access uses `POST /api/reports/admin/:id/download`, returning a 60-second URL. Public sharing is explicitly unavailable in capabilities and rejected by the server until a separate publication/scanning flow is qualified. No publisher is registered at startup, so HTTP submissions only queue reviewed content. The dormant issue transport includes only reviewed title/description/diagnostics and an opaque report ID, excluding model filename, model bytes, agreement and contact details.

## Recovery and deletion

Uploads resume using the same durable report/upload IDs and reselected source file; each part's checksum must match. Completion verifies actual storage part numbers and sizes, any available returned checksums, and stored object size; the background verifier then hashes the actual bytes before marking ready. Lost complete responses reconcile using object HEAD. The dormant issue transport includes lost-response reconciliation against the actual App author and independently committed publication intent. Startup publication remains disabled until the complete publication path has its runtime qualification. Generic error categories must not merge unrelated reports.

Models and report details expire after 30 days; incomplete uploads after one day. Independent bounded workers run retention and model verification every ten seconds. Submitted reports remain in the outbox; no publisher is registered. Shutdown cancels verification reads and leaves interrupted work available for retry. Owner DELETE removes private report content and model, but cannot retract an already-public GitHub issue. Storage failures retain cleanup work rather than falsely recording deletion. Audit events expire after 90 days. Backups/object versions must be configured and disclosed separately; the service cannot erase unmanaged backups. Alert on cleanup failures, outbox age and storage quotas before public launch.

Run checks through root `pnpm typecheck` and `pnpm test --filter=@ifc-lite/report-service --filter=@ifc-lite/report-contract`. Integration tests need real PostgreSQL and an isolated checksum-capable S3 bucket. No production deployment, account provisioning, live signing or live model transfer is implied by local tests.

Supply the GitHub App signing key through exactly one protected secret source: a PEM file path or the inline PEM with actual newlines. The environment option supports Railway without a startup file wrapper; never configure both or print/commit the key.

Approved NDA signing also requires an explicit `REPORT_AGREEMENT_VERSION` identifying the reviewed version. Missing, blank, draft or placeholder versions fail startup when approval is configured. Leave approval unset until the owner approves the exact text and version.

Verification distinguishes proven byte-integrity failures from provider/network errors. Transient reads and verification deadlines remain unpublished and retry with a PostgreSQL-persisted exponential delay from 10 seconds to 15 minutes; the original pending-upload expiry still applies. Shutdown cancellation leaves the work pending. A successful retry must read and hash the actual object before it becomes ready.

## Launch gate

Public submissions default to disabled. Only the exact value `REPORT_SUBMISSIONS_ENABLED=true` enables new user sessions and new report content. `GET /api/reports/capabilities` reports availability without allocating a session. Disabled new-session/content requests receive `503 submissions_disabled`. Existing owners can still recover their session, read their reports and delete them; normal ownership, Origin and CSRF checks continue to apply. Health and authenticated admin operations are independent of the launch gate.

Before public launch, an operator may configure a separate `REPORT_QUALIFICATION_TOKEN` of at least 32 characters and send it as the `X-Ifclite-Qualification` header for protected qualification requests. It must differ from admin/admission secrets. Keep this credential server/operator-only: never put it in viewer configuration, browser bundles, URLs or logs. The bypass permits admission, not cross-origin or CSRF bypass. Removing the token disables qualification access without disabling existing-owner deletion.


## Dormant publication transport

The transport now includes the issue-create recovery implementation qualified
in #7517. Before a POST it commits an opaque report-ID intent through an independent
database connection, while retaining the publisher's parent/outbox locks. A lost
response, outer transaction rollback or restart cannot authorize a second POST.
Retries reconcile the exact terminal marker against the authenticated App's
canonical numeric bot identity; optional App metadata must agree when supplied.
An empty or unavailable listing leaves `publicationHold: "review_required"` on
the owner receipt. There is no automatic reset of an ambiguous intent. Completed
or abandoned intents are retained for 90 days, and submitted intents are retained
while their report remains submitted. Deletion of private report data does not
undo an already-public issue.

This layer deliberately leaves startup publication disabled. Local loopback
protocol and PostgreSQL tests are not a new production qualification. Existing
live #7517 evidence retains its original source binding. This layer adds existing-issue comments and explicit PostHog correlation.
Live PostHog acceptance and deployment activation remain unqualified. Do not enable this transport or deploy it over N as a rollback.
### Verified existing-issue destination

Optional `REPORT_POSTHOG_HOST` (exact PostHog Cloud app origin), `REPORT_POSTHOG_PROJECT_ID` and server-only `REPORT_POSTHOG_API_KEY` enable an explicit lookup of the exact captured exception. Grant only the read scopes needed for event queries and error-tracking issue details. No lookup runs until the user asks. The service verifies the event UUID, session, build, recent timestamp, resolved PostHog issue and its sole linked open GitHub issue in the configured repository. Generic error categories are never deduplication keys. Unavailable, ambiguous or unmatched lookups leave the user an explicit choice to retry or create a separate issue.

The reviewed destination has a one-hour, session-bound signed receipt; its correlation is stored privately and erased with report deletion/retention. Public diagnostics never include event/session IDs. A bound submission publishes the reviewed text as a comment on that issue. Lost comment responses reconcile against a terminal per-report marker authored by the configured GitHub App. A closed/moved/unavailable issue or an incomplete reconciliation window holds the outbox; it never silently creates another issue. Existing comments remain public after private-data deletion.

Before enabling, qualify the configured PostHog query shape/read scopes with a real known exception and linked repository issue, then verify a user-reviewed comment in an authorized test issue. Local HTTP fixture tests do not establish that live integration or authorize production submissions.

The resolver uses PostHog’s dynamically added `events.issue_id`, not the historical `properties.$exception_issue_id`. The [pinned upstream database mapping](https://github.com/PostHog/posthog/blob/8c409d41eb190b96d4e0eaaef5fae11a2009c1cc/posthog/hogql/database/database.py#L3091) resolves current fingerprint ownership and is installed for ordinary project queries; the base `EventsTable` declaration alone omits these dynamic fields. Issue retrieval requires [`error_tracking:read`](https://posthog.com/docs/api/error-tracking-3). These source checks still require live verification against the configured project.

Operational routing, historical hosted receipts and activation gaps are tracked in the [deployment runbook](../../deploy/reports/railway.md). Before restoring a production snapshot, stop the entire API and all workers and complete the [independent deletion/outbox reconciliation procedure](../../deploy/reports/recovery.md). The admission flag alone does not pause workers; restore acceptance remains outstanding.
