# Georeference browser comparison (#10382)

The committed `reopen-held-pick.e2e.spec.ts` passed eight times on the PR and
eight times on its merged main base, alternating PR/main on one Pop host.
Both root viewer build graphs passed all 60 tasks before the comparison.
The test and build hashes, source identities, per-run counts, original worker
job, and hashes of the individual Playwright JSON reports are recorded in
`browser-ab.json`. Full reports remain with the private worker evidence.

The config used one worker, zero retries, the committed 180-second deadline,
fresh contexts, a private preview port with server reuse disabled, and headless
Chromium with Vulkan SwiftShader. It exercises the real viewer and IFC models;
it is software GPU correctness coverage, not a native GPU or performance claim.
The earlier restore timeout was not reproduced in this cohort. Eight passes
cannot establish that an intermittent failure is impossible.

A preceding harness attempt is excluded: its eight PR tests passed, but all
main attempts failed before test launch because a config imported the PR's
separate Playwright installation. The acceptance config imports no installation.
The original attempt and its logs were retained, not overwritten.

After these builds, the panel's unchanged map-unit display suffix formatter
was extracted into `effective-georef.ts` to satisfy its existing module budget.
Focused root Turbo georeference tests and pre-handoff separately validate that
extraction; the comparison above identifies the exact source it exercised.
