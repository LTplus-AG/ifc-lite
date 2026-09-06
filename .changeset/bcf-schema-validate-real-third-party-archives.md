---
"@ifc-lite/bcf": patch
---

Extend `schema-validation.test.ts` to validate two genuine third-party BCF archives already in the repo (`test-data/PerspectiveCamera.bcf`, `test-data/OrthogonalCamera.bcf`) against the vendored buildingSMART v2.1 XSDs, closing a gap where every schema-validation test checked only fixtures this codebase built by hand from its own understanding of the schema. Test-only, no source change.
