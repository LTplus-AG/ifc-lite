# Reviewed model report service

A separate Node service for user-reviewed GitHub reports and optional confidential model uploads. It uses PostgreSQL for sessions, admission quotas, reports, agreements, multipart ownership, audit events and the GitHub outbox. S3 stores private model objects; model bytes travel directly from the browser to storage in 16 MiB parts. It does not reuse cloud-account tokens or collaboration room storage.

## Deployment

HTTP submissions queue reviewed reports. Startup registers independent retention, model verification and GitHub publication workers. The publisher uses the qualified durable-intent and canonical-author transport for issues and reviewed existing-issue comments. This startup source unit requires its own runtime qualification before deployment; do not replace the existing qualified N deployment with an unqualified build. New user submissions, NDA signing and public model sharing remain subject to their separate launch gates.

Required disclosure configuration: `REPORT_STORAGE_PROVIDER`, `REPORT_STORAGE_LOCATION`, and `REPORT_BACKUP_DISCLOSURE`. These describe actual deployment; Switzerland is the legal recipient jurisdiction, not an inferred hosting location.

Required server configuration: `REPORT_VIEWER_ORIGIN` (exact HTTPS origin), `REPORT_DATABASE_URL`, `REPORT_S3_BUCKET`, `REPORT_S3_REGION`, `REPORT_S3_ACCESS_KEY_ID`, `REPORT_S3_SECRET_ACCESS_KEY`, `REPORT_ADMISSION_SECRET` (random 32+ characters), `REPORT_ADMIN_TOKEN` (separate random 32+ characters), `REPORT_GITHUB_APP_ID`, `REPORT_GITHUB_INSTALLATION_ID`, exactly one of `REPORT_GITHUB_PRIVATE_KEY_FILE` or `REPORT_GITHUB_PRIVATE_KEY`, and `REPORT_GITHUB_REPOSITORY`. `PORT` defaults to 3005. Optional S3-compatible configuration: `REPORT_S3_ENDPOINT`, `REPORT_S3_FORCE_PATH_STYLE=true`.

The GitHub App must be installed only on the destination repository with Issues read/write permission. Credentials remain server-side. `GET /healthz` checks PostgreSQL. Startup applies additive tables. Run one initial replica; background jobs serialize upload mutation using database locks. Session creation serializes count-and-insert for each verified admission identity across replicas.

Configure a private bucket, block public access and anonymous listing, mandatory encryption, exact viewer-origin PUT CORS permitting `x-amz-checksum-sha256` and exposing ETag/checksum headers, and lifecycle abortion of incomplete multipart uploads after one day. Disable versioning or install version-aware deletion/lifecycle before promising deletion. No CDN or public bucket endpoint is used. Every provider uses the same verification path: a bounded server-side read of the completed object verifies every 16 MiB part against the immutable authorized SHA256 ledger and records the full-object SHA256. Completion queues verification and responds immediately; clients poll until ready. Missing ListParts checksums are represented as unverified metadata, never treated as proof. This costs one full object read and any provider read/egress fees per verification attempt; process restart may require another read. Verification has a 15-minute deadline and exact size cap. Never put model names in object keys or logs. Runtime IAM needs only multipart/list/put/head/get/delete on the dedicated bucket prefix.

Route `/api/reports/*` from the viewer's exact origin to this service before the SPA rewrite. Requests use secure HttpOnly SameSite cookies; mutations validate origin and CSRF. Successful draft creation (including an idempotent retry) extends the authenticated owner session to cover the report’s full retention period and refreshes the same browser credential. Losing or clearing that cookie still loses anonymous owner access. Do not expose administrator credentials to viewer builds, browser storage or query strings. Administrator access is an operational bearer API, not a shipped maintainer login UI; place it behind the organization's authenticated gateway. Tokens are compared in constant time and downloads/custom-agreement decisions audited.

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

A dormant [isolated scanner runner](../../deploy/reports/scanner.md) now supplies
the real-engine adapter and qualification entrypoint. It is not started by the API.
Still required before enabling: qualification and deployment of that runner with
fresh signatures and measured resource limits, real clean IFC and EICAR refusal evidence,
actual deployment-provider immutable-copy and bounded-download qualification,
end-to-end viewer qualification, and idempotent public-link publication. The integration
tests use real PostgreSQL/S3 bytes and actual HTTP delivery but synthetic trusted
scanner attestations; they do not establish malware clearance. Conditional copy
behavior proven against local RustFS is not evidence for Scaleway. No new hosting
resources are provisioned here.

### Dormant independent restore journal

`RestoreJournal` is an operational prototype for the existing private encrypted
bucket, under a separate `operations/restore/<epoch>/` prefix. It records only an
opaque report ID and destructive action. It authenticates bounded immutable
entries with an independent HMAC key and advances the authenticated head using
conditional ETag writes. An unavailable journal, stale conditional write or
ambiguous response prevents an acknowledged effective deletion/withdrawal.
The entrypoint authenticates an explicitly configured, previously initialized
journal and supplies it to HTTP deletion, retention and integrity verification.
It never initializes a journal during startup. Unconfigured startup is limited
to a truly empty database with admission and background workers disabled, as
described below. Production initialization and admission remain off pending
independent custody and deployed recovery qualification.

`reconcileRestore` requires a complete chain matching an independently retained
checkpoint for that epoch. It commits a recovery hold before reading the chain;
failure leaves the hold in place. Recovery purges deleted/expired report content,
invalidates all restored owner sessions, pending outbox work, upload eligibility
and public grants, while retaining private object references and quota reserves
for confirmed cleanup. It never extends report expiry or releases its hold.
`REPORT_RESTORE_REQUIRED=true` prevents the entrypoint from starting; an existing
recovery hold also blocks startup, HTTP admission and background workers.

This is not an automatic disaster-recovery system. Before any restore, an
operator must independently stop/drain every replica and set the external
restore flag; a restored DB cannot attest that it was not rolled back. The
checkpoint must be retained outside the restored database and protected against
rollback. A missing checkpoint, lost signing key, simultaneous head rollback,
unknown historical deletions or unproven quiescence cannot be repaired by trusting
a caller boolean or by initializing a new empty journal. Keep the service held.
No automatic release, independent checkpoint custodian, key rotation, journal
retention policy, or deployed restore drill is implemented. The bounded chain
limit is 100,000 entries; capacity exhaustion fails closed. Enabling the runtime
requires those operational decisions and provider conditional-head qualification.
Previously issued presigned URLs can remain usable until their short expiry;
quiescence must include that expiry and multipart/provider reconciliation before
reopening. Never start the outbox publisher to discover whether old work is safe.

The intended qualification scope is **PostgreSQL-volume-only restore**, with the
existing Paris bucket explicitly excluded from the restore job. The authenticated
bucket head is an independent watermark relative to that database. Retain the
selected epoch/key outside PostgreSQL and capture the authenticated checkpoint
before and after the owned restore, together with the reviewed provider job/volume
identity and evidence that the bucket was not restored. Unknown bucket provenance,
head rollback, missing operator checkpoint custody or concurrent writers require
a hold. This scope does not establish safety for S3 rollback or a cross-provider
disaster; no second paid witness service is implied. The actual constrained
restore pipeline remains unqualified and runtime journaling remains off.

### Dormant journal runtime and explicit first initialization

Private admission (including `REPORT_QUALIFICATION_TOKEN`) requires an initialized
journal. Default submissions stay disabled. A database already bound to a journal
cannot start without the same epoch, key and storage target, even with admissions
disabled. Without a journal, only a truly empty admission-disabled database may start; no
background workers start in that mode. Existing synthetic qualification history
is not exempt and requires an explicit fresh-scope cutover, never deletion to
bypass the guard. Startup requires the actual database/schema to match both the protected custody
manifest and durable binding, then authenticates the existing object-store head.
Copying or renaming the database/schema does not authorize startup. Cross-target
restore stays held until an explicit operator target-reauthorization procedure
is designed and qualified; none is provided by this runtime. Startup never creates,
resets or transfers a journal. The HTTP handler, retention sweep and integrity
verifier share that journal. Shutdown drains HTTP requests and workers before
closing it. Startup failures use categorical logs without configuration values.

Configure **all** of `REPORT_JOURNAL_EPOCH` (64 lowercase hex characters), exactly
one of `REPORT_JOURNAL_HMAC_KEY` / `REPORT_JOURNAL_HMAC_KEY_FILE` (64 lowercase hex
characters generated from 32 random bytes), and `REPORT_JOURNAL_CUSTODY_FILE`.
Partial configuration is fatal even with admissions disabled. File inputs must be
regular, owned by the service UID, non-symlinks and inaccessible to group/others.
They must never be committed or included in PostgreSQL backups.

The protected JSON custody manifest has `version: 1`, `epoch`, `keyFingerprint`
(SHA-256 of the literal hex key), `database`, `schema`, `targetDigest`, `custodian`,
`independentLocation`, and `initialCheckpoint: {epoch, sequence: 0, hash: <64 zeros>}`.
`targetDigest` is SHA-256 of JSON encoding `[bucket, region, endpoint-or-null,
forcePathStyle-boolean]`, in that order. Operators must retain the key, initial
manifest and subsequent latest checkpoints independently of the database being
restored and verify the actual custody location and recovery access. File mode
checks and nonempty custodian fields cannot prove that independence. Production
custodian/location and provider restore qualification remain pending.

For a genuinely new, quiescent reporting database only, first prepare and retain
that manifest (database/schema must exactly match the initialization target).
Leave submissions disabled, remove the qualification token and stop all reporting
processes. Initialization requires a separately qualified operator runner using
a source checkout pinned to the exact reviewed service revision, its committed
lockfile and qualified dependencies (including `tsx` and built workspace
dependencies). Retain the runner revision and qualification receipt, verify its
protected configuration targets the intended fresh database/schema and storage,
and execute from that checkout’s repository root. The deployed Railway image
starts `dist/bin.js`; its production dependency set and build do not provide
this source-checkout initialization command. Do not assume `tsx` or the source
script is available there, and do not add initialization to deployment startup.
Only after the operator runner and independent custody are qualified, explicitly
invoke:

```sh
node --import tsx apps/report-service/scripts/initialize-journal.ts --confirm-independent-custody-and-quiescence
```

This command is never part of deployment/startup. It locks all reporting tables,
refuses any rows including tombstones/audit/admission/recovery/publication history
and refuses an already-used audit sequence, then conditionally creates the remote
head and commits a singleton lineage binding. Existing qualification canaries are
history: **do not delete them to make initialization pass**. A remote write followed
by DB failure remains closed; do not reset/delete/reinitialize to bypass it. Stop
and reconcile the partial initialization under an independently reviewed procedure.

The epoch identifies logical lineage, but startup also enforces matching database
and schema names in both custody and the durable binding. Cross-target restore
must remain held until an explicit target-reauthorization procedure is designed
and qualified; this runtime provides no transfer bypass. Matching names do not
identify a physical host or detect same-name copies on another host. This is
**not automatic rollback detection**. Before any restore, quiesce the entire API and every worker/scanner,
set the independent restore-required flag, retain the latest external checkpoint,
and reconcile deletions, withdrawals and outbox state while the DB recovery hold
remains set. Do not release the hold or restart publication merely because startup
can authenticate a remote head. A simultaneous DB/object-store rollback is not
excluded by reading that same object store.
