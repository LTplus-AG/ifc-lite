# Scan render frame mutation evidence (#8781)

The whole-change revert removes `reframeRegisteredPointClouds`, which the changed tests import. That prevents assertions from running (`REVERT-BROKE-BUILD`). The three workflow-declared patches keep the API and independently reverse observable behavior:

- `offset-subtraction.oracle.patch` removes render-offset subtraction from native and unaligned matrices.
- `reframe-apply.oracle.patch` drops the registry's renderer transaction while retaining the public function.
- `scan-candidate.oracle.patch` lets scan-only models define the shared frame again.

Each patch is in base-to-branch orientation for reverse application by `check-test-revert-oracle.mjs`. The witness is `apps/viewer/src/hooks/ingest/pointCloudRenderFrame.test.ts`.
