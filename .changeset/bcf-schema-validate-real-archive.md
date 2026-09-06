---
"@ifc-lite/bcf": patch
---

Add a test that validates a genuine, third-party-produced BCF archive (buildingSMART's own `PerspectiveCamera.bcf`/`OrthogonalCamera.bcf` test cases, already used elsewhere to test the reader) against the vendored BCF XSDs. Every prior schema-validation test checked our own writer's output against a fixture built from our own understanding of the schema; this closes the remaining gap by checking the vendored schemas against a file neither our writer nor our fixture-building had any hand in. No source change.
