# Canonical missing-validation instruction — #6610

Review4171484425 found a printed report implying it updates itself after validation.
The canonical English instruction is now “No validation report yet — run validation
to include results.” Captured translations retain their own instruction; no-label
PDF callers reuse this same English catalog key.

Qualified production/test source: `411c50c8bcea1131d5402029d9aacecb0bc28f98` on main `63a7c478`.
Test-only red: `3a3bb1019151b20a4085e15aa616149b23ad4ad0`.
The real public SketchUp IFC is parsed to four walls; a real committed PNG is
decoded and actual PDF bytes are independently read with PDF.js. This is paper
correctness, not a new native-browser or performance claim.

The red root-Turbo run completed 4PASS/1 genuine PDF output assertion failure,
0skips; the new mounted/headless/translated subcontrols were UNRUN after that
first PDF assertion. The unchanged new control on the minimal fix checks all
four: captured English PDF, mounted English paper, headless English PDF and
translated PDF after catalog/locale replacement during actual PNG preparation.

The green selected root test graph completed 51PASS/0FAIL/0SKIP: five actual-PDF
producer tests, three captured-number controls and 43 document invariants.
Its logged missing chart column is the deliberate #6612 chart-failure control
in document.test.ts; it is followed by that passing warning/output assertion.
The exact plain root `pnpm typecheck` wrapper passed all111 Turbo tasks and its
mandatory audit of 3,326 test files across57 packages. Root lint, module-size,
source-text-test and test-wiring gates all exited0 under the same guardian.

`raw-red-green.tar.gz` contains complete red/green logs and guardian JSON, exact
test-only/fix patches, gate logs/JSON and an internal SHA-256 file manifest.
Archive: 86417 bytes; SHA-256 `30a4b0f803852c7585605436199fb20438f4769f29a26d06d3ccfc3922932137`.
The evidence commit changes only this manifest/archive; qualified source,
tests, dependencies and build inputs remain byte-identical.

B's separate same-input image-reflow fix has its own actual17-test red/green
qualification. C/D source propagation does not add new runtime/native claims;
the inherited four-export native proof remains scoped to historical D325 only.
Fresh exact-head CI and answered substantive review still gate each landing.
