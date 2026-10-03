# Current takeover proof for #6610 / #6731–#6733

Production source: `cd3d65b7c`, incorporating B `b60f8f645` and C `bd13e3da0`. This evidence-only successor does not alter production source. The original parent proof remains historical and separately scoped.

WSL `/usr/bin/google-chrome` with the repository CI Vulkan/SwiftShader flags loaded the real public SketchUp `building-architecture.ifc` using the canonical model URL. The receipt records the actual source fingerprint/content hash and 14 retained meshes. Paper body lines are declared authored text, not a claim of model validation. The actual Export PDF button produced the attached eleven-page PDF. A page reload retained the complete authored document unchanged. The screenshots show the actual rendered model and the first/last full paper sheets, using the workspace Maximize control.

All 727 production assets were SHA-256 identical before and after browser proof (`assets.json`). No page errors occurred. Two resource-404 console messages occurred during initial load/reload and are retained in `receipt.json`; no zero-console-error claim is made. PyMuPDF 1.28.2 independently read every page: exact heading/footer text, font size and ink, two dates and current/total counters, two distinct logo placements, and body between the bands. PDF SHA-256: `fe613d4f4d6877883d23d580a4f5d316d3484bb9a8c61acbb34b1edb5a8d6a97`.

Validation:

- Current production source: `TEST_PATTERN='DocumentPreview.headingStamp|DocumentPanel.pageBands|DocumentPreview.lifecycle|PageHeadingEditor.logoOwnership|DocumentPanel.colors|document-preview.test' pnpm test --env-mode=loose --filter=@ifc-lite/viewer`: 23 passed, zero skips. Covers real emitted PDFs, exact upper/lower date glyphs, nonempty reset footers, captured-input immutability, successful/failing delayed PNG lifecycles, and composed body fills with an unfilled title. An earlier added coordinate assertion failed because it assumed a fixed logo-band line offset; it was corrected to require one exact date in each page band before this qualified run.
- Current source `pnpm typecheck`: 111 Turbo tasks; all 3,335 test files across 57 packages checked.
- Before review corrections, source `9d68e4436`: broad document selection 584 tests in 90 suites passed, zero skips; root lint passed 8,336 files across four targets. These logs remain explicitly baseline evidence, not a final-head rerun.

The first development-server proof used unsuitable GPU flags and was excluded. This directory contains the qualified production proof only. There is no performance claim. Merge still requires fresh main-base CI and resolved PR feedback.
