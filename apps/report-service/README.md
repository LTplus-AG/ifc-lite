# Model report service foundation

This private service foundation defines the reviewed reporting contract, durable PostgreSQL ownership and quotas, and optional version-bound confidentiality acceptance. It does not expose an HTTP server or upload endpoint in this layer. Subsequent changes add verified model transfers, the GitHub App/HTTP service and the viewer flow under issue #7495.

Automatic NDA issuance requires an explicitly approved exact template digest, LTplus AG issuer configuration and a licensed Unicode font. The repository draft is not approved for issuance. A caller must validate the configured font before enabling acceptance. Ordinary private upload consent remains independent of an NDA.

Run checks from the repository root using `pnpm typecheck` and `pnpm test --filter=@ifc-lite/report-service --filter=@ifc-lite/report-contract`. Real agreement tests use an isolated PostgreSQL database and `REPORT_TEST_FONT_FILE`; the dedicated integration workflow provides both.
