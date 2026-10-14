# Dormant public-model scanner (#7495)

This layer supplies a real ClamAV adapter and a one-job trusted orchestrator. It
adds no API worker, public ingress, hosting resource or activation environment
variable. `loadConfig` still cannot enable public sharing. Ordinary private
attachments and optional owner-approved NDA signing remain separate workflows.

## Boundaries

The trusted orchestrator alone accesses PostgreSQL and the private object store.
It leases one already-verified, consented model, pins the object ETag, downloads
bounded bytes, verifies the complete SHA256 and checks the uncompressed STEP
header/footer envelope. This is format admission, not IFC schema validation.

The file-reading ClamAV container has a pinned linux/amd64 manifest, no network,
no Docker socket, no application credentials, no writable model/signatures,
UID/GID 65534, no capabilities, no new privileges, one CPU, 4 GiB memory without
additional swap, 64 processes and 64 MiB disposable scratch. Only a fixed-name
model and copied signed database files are mounted. Raw subprocess output is
bounded to 64 KiB and never logged or persisted. Any unexpected diagnostic,
limit, incomplete result, crash or timeout cannot produce a clean attestation.
The engine's file cap covers the allowed 1 GiB model; scan-work cap is 2 GiB,
with limit alerts enabled. The independent container timeout also terminates a
scan if its trusted orchestrator dies.

FreshClam runs separately with network access but **without model access or
application credentials**. Full signed CVD files, including a daily database
built within 24 hours, are copied to each scan. The actual scan loads and
validates those databases. Metadata is taken from the copied daily header and
actual engine output. Incremental/local custom signatures are not admitted.
The source manifest digest is pinned in `scanner-sandbox.ts`; an upgrade needs
new actual-engine qualification.

The database singleton excludes simultaneous trusted jobs. A dedicated scratch
root records each owned container name before launch; the next worker stops an
abandoned sandbox and erases its scratch before claiming work. Use one dedicated
scratch root per database, never a shared general temporary directory. Live
leases last 20 minutes and at most three attempts. Worker operations have a
15-minute deadline. Failed scans stay held; clean evidence only reaches human
review. Deletion, expiry and withdrawal are rechecked when results are recorded.

## Manual qualification, not production activation

On a trusted Linux Docker host, build through the root workspace graph and pull
`SCANNER_IMAGE` exported by the built module. Provision only fixture credentials
for the existing isolated PostgreSQL/S3 test services. Set:

- `REPORT_SCANNER_SIGNATURE_DIRECTORY`: dedicated signature directory.
- `REPORT_SCANNER_SCRATCH_DIRECTORY`: dedicated private scratch root for this DB.
- `REPORT_DATABASE_URL`, `REPORT_S3_BUCKET`, `REPORT_S3_REGION`,
  `REPORT_S3_ENDPOINT`, `REPORT_S3_ACCESS_KEY_ID`, `REPORT_S3_SECRET_ACCESS_KEY`.
- `REPORT_S3_FORCE_PATH_STYLE=true` only for an endpoint requiring that style.

Run `pnpm exec tsx apps/report-service/scripts/scan-public-once.ts update-signatures`
before scanning, with no confidential files mounted. Then invoke the same script
with `scan-once`. These commands never enable public admission or promotion.
Do not run signature updates concurrently with a scan in a constrained runtime.

The dedicated CI job provisions actual signed definitions and a real engine;
`REPORT_REQUIRE_SCANNER=true` rejects missing prerequisites. Local source/storage
tests may run without an engine, but skipped engine cases are **not clearance**.
The clean model is the catalogued public FZK fixture (`pnpm fixtures
ara3d/AC20-FZK-Haus.ifc`). The harmless canonical 68-byte EICAR file tests the
actual engine separately; the full pipeline rejects that non-STEP file. A sparse
fixture crosses the actual 1 GiB engine cap and must never receive a complete
clean result. Public-contract tests using synthetic scanner attestations remain
separate and cannot replace these checks.

An initial embedded-EICAR acceptance expectation was invalid: our actual engine
detected canonical EICAR, but returned OK for the pattern inside a STEP comment,
including after 1 MiB of padding. The [ClamAV maintainer's explanation](https://github.com/Cisco-Talos/clamav/issues/1354)
confirms whole-file hash and restricted trailing-whitespace EICAR semantics.
The failed expectation and measured outcomes are preserved in the qualification
receipt; no custom signature was introduced. A clean result means the qualified
engine returned a complete clean outcome. It does not guarantee absence of all
malware, confidential information, copyright restrictions or missing consent.

## Still required before activation

- Actual clean/infected/large-tail/limits/OOM/restart sandbox qualification and
  measured memory, scratch and elapsed-time limits on the selected EU runner.
- An isolated EU worker deployment with scoped credentials; the current Node API
  container and its resource ceiling are not that scanner security boundary.
- Authenticated exact-hash maintainer review, rescan/review recovery for expired
  attestations, and idempotent GitHub public-link publication.
- Operational restore/deletion reconciliation and the final same-origin viewer
  acceptance. No public model grants or NDA approval follow from this document.

ClamAV recommends [3–4 GiB RAM](https://docs.clamav.net/manual/Installing/Docker.html).
The chosen 4 GiB container cap is a candidate limit until measured with the
qualified engine/database snapshot; exceeding it must hold a model, not relax
scan coverage.
