# Model report service foundation

This private service foundation defines the reviewed reporting contract, durable PostgreSQL ownership and quotas, and optional version-bound confidentiality acceptance. It does not expose an HTTP server or upload endpoint in this layer. Subsequent changes add verified model transfers, the GitHub App/HTTP service and the viewer flow under issue #7495.

Automatic NDA issuance requires an explicitly approved exact template digest, LTplus AG issuer configuration and a licensed Unicode font. The repository draft is not approved for issuance. A caller must validate the configured font before enabling acceptance. Ordinary private upload consent remains independent of an NDA.

Run checks from the repository root using `pnpm typecheck` and `pnpm test --filter=@ifc-lite/report-service --filter=@ifc-lite/report-contract`. Real agreement tests use an isolated PostgreSQL database and `REPORT_TEST_FONT_FILE`; the dedicated integration workflow provides both.

Supply the GitHub App signing key through exactly one secret source: `REPORT_GITHUB_PRIVATE_KEY_FILE` points to a readable protected PEM file, or `REPORT_GITHUB_PRIVATE_KEY` contains the PEM with actual newlines (for hosts such as Railway that inject secret environment values). Do not configure both, print the key, or commit it. Use the hosting platform's secret-variable facility and restrict access to service operators; no startup file wrapper is required for the environment option.

Approved NDA signing also requires an explicit `REPORT_AGREEMENT_VERSION` identifying the reviewed version (for example `2026-10-12.v1`); missing, blank, draft, or placeholder versions fail startup when approval is configured. Leave approval unset until the owner approves the exact text and version.
The verified-storage layer adds direct 16 MiB multipart transfers, durable resume ownership, and bounded server-side verification of every stored byte against the authorized SHA-256 ledger before a model becomes ready. Deletion and retention cancel in-flight verification and retry failed cleanup. No HTTP upload endpoint is exposed yet.

Verification distinguishes proven byte-integrity failures from provider/network errors. Transient reads and verification deadlines remain unpublished and retry with a PostgreSQL-persisted exponential delay from 10 seconds to 15 minutes; the original pending-upload expiry still applies. Shutdown cancellation leaves the work pending. A successful retry must read and hash the actual object before it becomes ready.
