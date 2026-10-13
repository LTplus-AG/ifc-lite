# Reviewed model report service

A separate Node service for user-reviewed GitHub reports and optional confidential model uploads. It uses PostgreSQL for sessions, admission quotas, reports, agreements, multipart ownership, audit events and the GitHub outbox. S3 stores private model objects; model bytes travel directly from the browser to storage in 16 MiB parts. It does not reuse cloud-account tokens or collaboration room storage.

## Deployment

HTTP submissions queue reviewed reports. Startup registers independent retention, model verification and GitHub publication workers. The publisher uses the qualified durable-intent and canonical-author transport for issues and reviewed existing-issue comments. This startup source unit requires its own runtime qualification before deployment; do not replace the existing qualified N deployment with an unqualified build. New user submissions, NDA signing and public model sharing remain subject to their separate launch gates.

Required disclosure configuration: `REPORT_STORAGE_PROVIDER`, `REPORT_STORAGE_LOCATION`, and `REPORT_BACKUP_DISCLOSURE`. These describe actual deployment; Switzerland is the legal recipient jurisdiction, not an inferred hosting location.

Required server configuration: `REPORT_VIEWER_ORIGIN` (exact HTTPS origin), `REPORT_DATABASE_URL`, `REPORT_S3_BUCKET`, `REPORT_S3_REGION`, `REPORT_S3_ACCESS_KEY_ID`, `REPORT_S3_SECRET_ACCESS_KEY`, `REPORT_ADMISSION_SECRET` (random 32+ characters), `REPORT_ADMIN_TOKEN` (separate random 32+ characters), `REPORT_GITHUB_APP_ID`, `REPORT_GITHUB_INSTALLATION_ID`, exactly one of `REPORT_GITHUB_PRIVATE_KEY_FILE` or `REPORT_GITHUB_PRIVATE_KEY`, and `REPORT_GITHUB_REPOSITORY`. `PORT` defaults to 3005. Optional S3-compatible configuration: `REPORT_S3_ENDPOINT`, `REPORT_S3_FORCE_PATH_STYLE=true`.

The GitHub App must be installed only on the destination repository with Issues read/write permission. Credentials remain server-side. `GET /healthz` checks PostgreSQL. Startup applies additive tables. Run one initial replica; background jobs serialize upload mutation using database locks. Session creation serializes count-and-insert for each verified admission identity across replicas.

Configure a private bucket, block public access and anonymous listing, mandatory encryption, exact viewer-origin PUT CORS permitting `x-amz-checksum-sha256` and exposing ETag/checksum headers, and lifecycle abortion of incomplete multipart uploads after one day. Disable versioning or install version-aware deletion/lifecycle before promising deletion. No CDN or public bucket endpoint is used. Every provider uses the same verification path: a bounded server-side read of the completed object verifies every 16 MiB part against the immutable authorized SHA256 ledger and records the full-object SHA256. Completion queues verification and responds immediately; clients poll until ready. Missing ListParts checksums are represented as unverified metadata, never treated as proof. This costs one full object read and any provider read/egress fees per verification attempt; process restart may require another read. Verification has a 15-minute deadline and exact size cap. Never put model names in object keys or logs. Runtime IAM needs only multipart/list/put/head/get/delete on the dedicated bucket prefix.

Route `/api/reports/*` from the viewer's exact origin to this service before the SPA rewrite. Requests use secure HttpOnly SameSite cookies; mutations validate origin and CSRF. Do not expose administrator credentials to viewer builds, browser storage or query strings. Administrator access is an operational bearer API, not a shipped maintainer login UI; place it behind the organization's authenticated gateway. Tokens are compared in constant time and downloads/custom-agreement decisions audited.

Admission is durable across recreated browser sessions. Daily quotas apply to an HMAC of the verified client address. Forwarded headers are ignored unless the socket peer matches explicit `REPORT_TRUSTED_PROXY_CIDRS`; then the nearest untrusted hop is selected from right to left. Configure only actual ingress CIDRs and require ingress to append the observed peer; never trust all addresses. Without configured trusted ingress, proxy users conservatively share the socket-peer quota. Default limits: 20 reports and 4 GiB reserved upload bytes per peer/day, 100 GiB outstanding global storage, 2 GiB/model. Browser concurrency is two parts; presigned URLs expire after five minutes and are bound to exact part, size and SHA256. Replayed URLs can replace only the same checksummed part while its upload remains active.

## Confidentiality

Ordinary private upload consent permits only diagnosing and verifying the reported defect. Standard and custom NDA workflows are optional. The owner approved the exact [LTplus AG agreement](../../legal/model-report-confidentiality-agreement-2026-10-13.v2.txt), version `2026-10-13.v2`, SHA-256 `8977cc03be648645f5b4f568cc9506beddd07f42547e25ace1da530cba37bbbb`, for later automated issuance. The container includes those exact text bytes at `/service/legal/model-report-confidentiality-agreement-2026-10-13.v2.txt`. Configure `REPORT_AGREEMENT_FILE`, `REPORT_AGREEMENT_VERSION`, and `REPORT_APPROVED_AGREEMENT_SHA256` only after the separate technical launch gates pass; the image sets none of these values. Missing approval disables signing while reports and ordinary private uploads still work. A mismatched digest, draft marker or placeholder fails startup. Approved text must contain exactly one `Agreement version:` declaration matching the configured version. The issuer is LTplus AG, Switzerland; hosting geography is a separate deployment fact. Accepted text version/digest, signer declarations, server date and PDF digest are retained. The PDF records electronic acceptance; it is not a qualified digital signature or verified identity claim. Approved signing additionally requires `REPORT_AGREEMENT_FONT_FILE`, a licensed Unicode font covering the approved text and supported signer names. The supplied Docker image includes DejaVu Sans at `/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf` and its package licence. Startup verifies template glyph coverage before enabling signing; the PDF embeds a subset. Unsupported signer characters are rejected clearly before acceptance, never replaced silently.

Custom agreements remain manual review requests. `GET /api/reports/admin/pending` lists the latest 100 reports; `GET /api/reports/admin/:id` retrieves private reviewed details and the custom agreement reference. Both require the configured maintainer bearer and are audited. `POST /api/reports/admin/:id/custom-nda` with authenticated administrator bearer and `{accepted:true,signedAgreementReference:"private document reference"}` records completed review and unlocks the requested upload. The service does not pretend a user-supplied document was automatically signed.

Private model access uses `POST /api/reports/admin/:id/download`, returning a 60-second URL. Public sharing is explicitly unavailable in capabilities and rejected by the server until a separate publication/scanning flow is qualified. The publisher includes only reviewed title/description/diagnostics and an opaque report ID, excluding model filename, model bytes, agreement and contact details.

## Recovery and deletion

Uploads resume using the same durable report/upload IDs and reselected source file; each part's checksum must match. Completion verifies actual storage part numbers and sizes, any available returned checksums, and stored object size; the background verifier then hashes the actual bytes before marking ready. Lost complete responses reconcile using object HEAD. GitHub issue/comment recovery reconciles the canonical App-author marker against an independently committed publication intent. Generic error categories must not merge unrelated reports.

Models and report details expire after 30 days; incomplete uploads after one day. Independent bounded workers run retention and model verification every ten seconds. The publisher processes eligible submitted reports from the outbox without blocking retention or model verification. Shutdown cancels verification reads and leaves interrupted work available for retry. Owner DELETE removes private report content and model, but cannot retract an already-public GitHub issue. Storage failures retain cleanup work rather than falsely recording deletion. Audit events expire after 90 days. Backups/object versions must be configured and disclosed separately; the service cannot erase unmanaged backups. Alert on cleanup failures, outbox age and storage quotas before public launch.

Run checks through root `pnpm typecheck` and `pnpm test --filter=@ifc-lite/report-service --filter=@ifc-lite/report-contract`. Integration tests need real PostgreSQL and an isolated checksum-capable S3 bucket. No production deployment, account provisioning, live signing or live model transfer is implied by local tests.

Supply the GitHub App signing key through exactly one protected secret source: a PEM file path or the inline PEM with actual newlines. The environment option supports Railway without a startup file wrapper; never configure both or print/commit the key.

Approved NDA signing requires an explicit `REPORT_AGREEMENT_VERSION` matching the exact text’s declaration. Missing, blank, draft, placeholder, mismatched or undeclared versions fail startup when approval is configured. Owner approval of v2 is complete; leave the runtime approval unset until complete-source, private access, provider disclosure, custody, retention, deletion, backup and restore qualification passes. The historical [v1-era draft](../../legal/model-report-confidentiality-draft.md) remains unchanged as evidence and is not the approved runtime asset.

Verification distinguishes proven byte-integrity failures from provider/network errors. Transient reads and verification deadlines remain unpublished and retry with a PostgreSQL-persisted exponential delay from 10 seconds to 15 minutes; the original pending-upload expiry still applies. Shutdown cancellation leaves the work pending. A successful retry must read and hash the actual object before it becomes ready.

## Launch gate

Public submissions default to disabled. Only the exact value `REPORT_SUBMISSIONS_ENABLED=true` enables new user sessions and new report content. `GET /api/reports/capabilities` reports availability without allocating a session. Disabled new-session/content requests receive `503 submissions_disabled`. Existing owners can still recover their session, read their reports and delete them; normal ownership, Origin and CSRF checks continue to apply. Health and authenticated admin operations are independent of the launch gate.

Before public launch, an operator may configure a separate `REPORT_QUALIFICATION_TOKEN` of at least 32 characters and send it as the `X-Ifclite-Qualification` header for protected qualification requests. It must differ from admin/admission secrets. Keep this credential server/operator-only: never put it in viewer configuration, browser bundles, URLs or logs. The bypass permits admission, not cross-origin or CSRF bypass. Removing the token disables qualification access without disabling existing-owner deletion.


## Publication transport

The transport includes the issue-create recovery implementation qualified
in #7517. Before a POST it commits an opaque report-ID intent through an independent
database connection, while retaining the publisher's parent/outbox locks. A lost
response, outer transaction rollback or restart cannot authorize a second POST.
Retries reconcile the exact terminal marker against the authenticated App's
canonical numeric bot identity; optional App metadata must agree when supplied.
An empty or unavailable listing leaves `publicationHold: "review_required"` on
the owner receipt. Every committed intent permits at most one POST attempt. A definite HTTP rejection, an expiry after intent, or a crash before sending also requires maintainer review; there is no automatic intent reset. Completed
or abandoned intents are retained for 90 days, and submitted intents are retained
while their report remains submitted. Deletion of private report data does not
undo an already-public issue.

Startup runs the publisher on the same bounded worker cadence as retention and
verification. The real-process loopback/PostgreSQL witness must qualify this
registration; local tests do not establish a new production qualification.
Existing live #7517 evidence retains its original source binding. Live PostHog
acceptance and deployment activation remain separate qualifications. New user
submissions, NDA signing and public model sharing remain disabled until their
launch gates are complete.
### Verified existing-issue destination

Optional `REPORT_POSTHOG_HOST` (exact PostHog Cloud app origin), `REPORT_POSTHOG_PROJECT_ID` and server-only `REPORT_POSTHOG_API_KEY` enable an explicit lookup of the exact captured exception. Grant only the read scopes needed for event queries and error-tracking issue details. No lookup runs until the user asks. The service verifies the event UUID, session, build, recent timestamp, resolved PostHog issue and its sole linked open GitHub issue in the configured repository. Generic error categories are never deduplication keys. Unavailable, ambiguous or unmatched lookups leave the user an explicit choice to retry or create a separate issue.

The reviewed destination has a one-hour, session-bound signed receipt; its correlation is stored privately and erased with report deletion/retention. Public diagnostics never include event/session IDs. A bound submission publishes the reviewed text as a comment on that issue. Lost comment responses reconcile against a terminal per-report marker authored by the configured GitHub App. A closed/moved/unavailable issue or an incomplete reconciliation window holds the outbox; it never silently creates another issue. Existing comments remain public after private-data deletion. Issue and comment reconciliation follows the response `Link` next relation within a ten-page budget. A short page with another page remains incomplete; a full final page without a next relation is complete. An incomplete budget window refuses publication, while a prior committed intent always prevents another POST.

Before enabling, qualify the configured PostHog query shape/read scopes with a real known exception and linked repository issue, then verify a user-reviewed comment in an authorized test issue. Local HTTP fixture tests do not establish that live integration or authorize production submissions.

The resolver uses PostHog’s dynamically added `events.issue_id`, not the historical `properties.$exception_issue_id`. The [pinned upstream database mapping](https://github.com/PostHog/posthog/blob/8c409d41eb190b96d4e0eaaef5fae11a2009c1cc/posthog/hogql/database/database.py#L3091) resolves current fingerprint ownership and is installed for ordinary project queries; the base `EventsTable` declaration alone omits these dynamic fields. Issue retrieval requires [`error_tracking:read`](https://posthog.com/docs/api/error-tracking-3). These source checks still require live verification against the configured project.

Operational routing, historical hosted receipts and activation gaps are tracked in the [deployment runbook](../../deploy/reports/railway.md). Before restoring a production snapshot, stop the entire API and all workers and complete the [independent deletion/outbox reconciliation procedure](../../deploy/reports/recovery.md). The admission flag alone does not pause workers; restore acceptance remains outstanding.

### Public model quarantine foundation (not enabled)

Production configuration leaves public sharing disabled; no environment variable
enables it. The delivery protocol can be exercised only with explicitly injected
qualification configuration. It does not qualify a malware scanner. Private
support uploads retain their existing limits and consent.

A future public submission must carry separate versioned permission covering
redistribution authority, review of confidential content, irreversible downloaded
copies, and posting a download link. A standard or custom NDA already attached to
that report prevents public sharing even when a later upload selects no NDA.
Initial public admission is `.ifc` up to 1 GiB; the scanner must independently
verify uncompressed STEP format rather than trust the filename.

After canonical actual-byte verification, submission binds a private quarantine
job to the full SHA-256, byte count, consent, policy and expiry. Only a trusted
scanner worker can lease the job; leases expire after 20 minutes and stop after
three attempts. A clean result must name the qualified immutable scanner image,
fresh signatures (at most 24 hours old), STEP format, exact bytes and complete scan. Infection,
inconclusive/limited scans, changed bytes, stale signatures and stale worker
leases cannot advance it. A second maintainer review must explicitly approve
redistribution and confidentiality of the same hash. Malware clearance alone
proves neither permission nor privacy.

Deletion or withdrawal commits revocation before storage cleanup. Scan results
cannot revive a revoked report; private hashes, consent and review evidence are
erased. Provider cleanup failures retain the existing upload record and capacity
reservation for retry.

Approved, published reports can now be copied into a separate immutable object
in the same private bucket. Conditional creation plus a full destination reread
must match the approved SHA-256 and byte count, including after an ambiguous
provider response. Consent, current signatures and review are checked again after
copying. Original and copy each reserve storage capacity until confirmed deletion.
Three bounded copy attempts precede a hold; expired leases cannot publish.

`GET /api/reports/public/<independent-256-bit-token>` streams the pinned copy with
a generic `model.ifc` filename. It exposes neither original filename, report UUID,
object key nor presigned URL. Shared database leases bound concurrent transfers;
a daily byte budget conservatively charges whole files even for interrupted
requests. Downloads time out after 15 minutes, reject range requests, and have
no-store/no-referrer headers. Owner-authenticated, CSRF-protected
`DELETE /api/reports/:id/public-model` immediately prevents fresh downloads while
keeping the private support original. Admission durably pins the specific report
and immutable object before provider open. Already-admitted downloads may finish;
saved copies cannot be recalled. Withdrawal/deletion/expiry deny fresh admission
immediately, while physical copy deletion and quota release wait for matching
transfer completion/disconnect or its bounded lease expiry (16 minutes from
admission, including the one-minute margin beyond the 15-minute transfer deadline).
Lease removal failure or process death retains that bounded hold. Legacy leases
without object identity conservatively hold copy cleanup until their recorded
expiry; no existing active transfer is inferred safe to delete during upgrade.
Deletion/expiry also revoke access; cleanup retries provider
failures without releasing storage quota early. Restores must keep public workers
and delivery disabled until deletion/withdrawal tombstones are reconciled.

Still required before enabling: an isolated scanner runner with qualified
signature updates and resource limits, real clean IFC and EICAR refusal evidence,
actual deployment-provider immutable-copy and bounded-download qualification,
reviewed viewer consent, and idempotent public-link publication. The integration
tests use real PostgreSQL/S3 bytes and actual HTTP delivery but synthetic trusted
scanner attestations; they do not establish malware clearance. Conditional copy
behavior proven against local RustFS is not evidence for Scaleway. No new hosting
resources are provisioned here.
