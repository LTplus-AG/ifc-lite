# Reporting service deployment proposal (#7495)

Status: infrastructure provisioning in progress. The private Paris bucket is provisioned and has passed a live public-fixture storage check. The isolated Amsterdam PostgreSQL deployment has been requested. Reporting API exposure, GitHub publication, viewer activation and NDA issuance remain disabled.

## Existing infrastructure inventory

Read from the authenticated Railway project and GitHub organization on 2026-10-12:

- Railway project `ifc-lite-server` has one `production` environment and six services: the IFC API, collaboration server, Superset, cloud gateway, Autodesk gateway and PostgreSQL.
- All six latest deployment manifests specify `us-west2` (California). PostgreSQL has a 5,000 MB volume, with approximately 219 MB reported in use at inspection. This is capacity information, not permission to share its application credentials or alter its schema.
- At the initial inventory, no project bucket or reporting service existed. The database backup schedule list is empty; the single returned manual backup record has an expiry in the past. It does not establish a current recoverable backup.
- Existing organization GitHub Apps include an IFC Lite assistant with Issues write permission, but it also has broad code/actions permissions. A dedicated reporting App restricted to the IFC Lite repository is the proposed least-privilege identity; no reporting private key was provisioned or retrieved.

The user selected existing infrastructure first and Railway as the preferred host. The user selected Europe with isolated report data and authorised the Railway Amsterdam + Scaleway Paris proposal after reviewing a $20–25/month planning budget. Existing cloud, AI and release services retain their current owners and configuration.

## Prepared resources

Two isolated services were created in the existing project: `model-reports` (`a3bf818a-fc34-4a61-9028-bc57a69ac525`) and `reports-postgres` (`ba20fcb2-a830-44ca-a1dd-785d68200534`). Environment configuration confirms both use `europe-west4-drams3a`. The API has its Dockerfile and health check configured but no deployment. PostgreSQL has its own Amsterdam volume (`06e81a4c-e500-4562-926c-067acfe89ccd`), generated credentials and pinned PostgreSQL 17 Alpine image; its initial deployment returned SUCCESS and its manifest confirms Amsterdam. Application database connectivity and restore remain unqualified. The Pro volume capacity defaults to 50 GB; [billing is based on used storage](https://docs.railway.com/volumes/reference), including filesystem metadata, rather than the capacity limit. A daily backup schedule was configured; [provider retention is six days](https://docs.railway.com/volumes/backups), while native backup location is confirmed as Amsterdam by the provider; restoration still needs qualification.

Scaleway bucket `ifclite-private-model-reports-par` is private in `fr-par`, with read-back AES256 SSE-ONE encryption, production-origin PUT CORS and an enabled one-day incomplete-MPU abort rule. Versioning and object lock are disabled. Dedicated application `ifclite-model-reports` has only bucket read and object read/write/delete permission sets on the dedicated IFClite upload service project. Temporary bucket-write configuration permission was removed. Its key is retained only in protected local configuration pending service secret installation. Live fixture upload/hash/corruption/privacy/deletion receipts are in `tests/evidence/model-reports-7495/`. The console activated a 750 GB, 90-day storage trial ending 2027-01-10; regular prices apply afterward. Runtime bucket-configuration write now returns 403 after revocation. Live service subprocess restart/resume has passed with a 616 MiB synthetic object in 39 parts; production API integration remains unqualified.

## Proposed topology

Run the reporting API as a separate Railway service using `apps/report-service/Dockerfile`, one replica, sleeping disabled and `/healthz`. Route only `/api/reports/*` from the viewer origin to it. Keep the viewer's `VITE_MODEL_REPORTS_ENABLED` flag off until acceptance passes. The report service uses its own database/role and private object bucket; never use cloud-account credentials, collaboration files or fixture storage for confidential submissions.

Railway's [native bucket documentation](https://docs.railway.com/storage-buckets) currently lists multipart upload as supported but server-side encryption and bucket lifecycle configuration as unsupported. The service explicitly requests S3 encryption and requires incomplete-upload cleanup. Therefore a native bucket is not qualified for this implementation. Use Scaleway Standard Multi-AZ Object Storage in Paris with bucket-default SSE-ONE (AES256), and qualify that exact provider before enabling uploads. Do not remove encryption requirements simply to make an API call pass.

Railway's [region reference](https://docs.railway.com/deployments/regions) identifies California and Amsterdam options; neither is Switzerland. The disclosure must name the actual API/database/object/backup locations. Moving the report data to Europe means isolating its database as well as its model storage; do not move existing production services as part of this work.

## Approved preparation target and estimated cost

- Railway: separate reporting API and PostgreSQL services in `europe-west4-drams3a` (Amsterdam), isolated credentials and database volume. Existing California services remain unchanged.
- Scaleway: private Standard Multi-AZ bucket in `fr-par` (Paris), default [SSE-ONE AES256 encryption](https://www.scaleway.com/en/docs/object-storage/api-cli/enable-sse-one/), exact-origin CORS, incomplete-upload cleanup and a dedicated least-privilege application identity. The provider documents [SHA256 multipart checksums](https://www.scaleway.com/en/docs/object-storage/reference-content/supported-checksums/).
- Planning budget: $20–25/month equivalent before tax for a small launch, not a fixed quote or guaranteed cap. [Railway rates](https://docs.railway.com/pricing/plans) imply about $12.75/month at combined 1 GB average RAM, 0.1 average vCPU and 5 GB volume usage, plus outbound traffic/backups. Existing unused plan credit may offset usage. [Scaleway's published Paris rate](https://www.scaleway.com/en/pricing/storage/) is €0.01606/GB/month for storage, with requests/ingress included and 75 GB outbound/month included, then €0.01/GB. Actual retention, object billing units, verification reads, downloads, backups and traffic determine charges.
- Keep the service's 2 GiB/model, 4 GiB/peer/day and 100 GiB outstanding reservation limits, and configure provider usage alerts. Alerts are not hard billing caps.

## Activation sequence

1. Confirm region/provider and cost, provision isolated resources, configure provider encryption, exact-origin upload CORS, multipart-abort lifecycle, retention and backups. Record restoration and deletion procedures, including backup expiry.
2. Install a dedicated GitHub App on `LTplus-AG/ifc-lite` with Issues read/write and metadata read only. Disable unused webhooks and user OAuth. Store the private key and installation ID only in protected service configuration.
3. Configure the required environment variables in the [service runbook](../../apps/report-service/README.md), authenticated maintainer gateway and concrete provider/backup disclosures. Apply migrations with the dedicated database role. Ensure ingress identity handling is qualified before enabling per-peer quotas.
4. Qualify the built container, live HTTPS origin/CSRF/ownership controls, real App issue publication and ambiguous-response recovery, private download, multipart restart/resume, corrupt input, cancellation and deletion on the selected storage. Use public or explicitly synthetic model fixtures.
5. Enable the viewer only after those receipts and CI/reviews pass. Keep standard NDA signing off until the exact completed [LTplus draft](../../legal/model-report-confidentiality-draft.md), version and SHA256 receive owner approval. A company contact update does not constitute that approval.

Public model sharing and verified linking to existing PostHog issues remain separate unfinished acceptance items under #7495. Local fixture tests and this proposal do not close the issue.

## Residency clarification discovered during qualification

[Railway staff confirm](https://station.railway.com/questions/data-residency-storage-region-for-volu-f90b5ca6) that native volume backups are stored in the deploy region (Amsterdam here), but application/deployment/build/HTTP logs are stored in US West. The same clarification says separate internal disaster-recovery copies are outside that native-backup location statement and Railway offers no contractual EU-only processing commitment. Amsterdam deployment therefore does not establish fully European processing. No confidential submissions are enabled. The user chose to proceed with Railway Amsterdam with these limitations disclosed and private content excluded from logs. The API logs only categorical error names; PostgreSQL is configured with statement logging disabled, error statement logging restricted to panic, terse error output and parameter-value logging disabled. A temporary Amsterdam qualification service queried the hosted PostgreSQL settings over private networking and verified them; it was then removed. The actual SQL receipt is `tests/evidence/model-reports-7495/hosted-database-logging.json`. Application startup/idle-pool failure tests also verify that sentinel credential URLs and private paths never appear in process output. Production App/ingress and restore qualification remain outstanding. No existing service or peer lane is being migrated.

The reporting API now has protected S3 and database-reference configuration installed with deployment skipped. GitHub App credentials, provider ingress qualification, authenticated maintainer access and live publication remain pending. No viewer activation or NDA approval has been inferred from the hosting decision.
