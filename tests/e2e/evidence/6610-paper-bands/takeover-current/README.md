# Current takeover proof for #6610 / #6731–#6733

Production source: `f00b2fe12dcc4f845e74c536945c10845e93049a`, including B `6b90b6678` and D `1eab725ed`. Final qualification union `da2a6fc2b` adds only three test-file review corrections; its production source is byte-identical. This evidence-only successor changes no production source. Earlier artifacts in Git history remain historical.

WSL `/usr/bin/google-chrome` with repository CI Vulkan/SwiftShader flags loaded the real public SketchUp `building-architecture.ifc` through the canonical model URL. The receipt records the actual source fingerprint/content hash and 14 retained meshes. Paper body lines are declared authored text, not model-validation evidence. The actual Export PDF button produced the attached eleven-page PDF. Reload retained the complete authored document unchanged. Screenshots show the rendered model and first/last full sheets using Maximize; privacy disclosure was dismissed through its actual UI before capture.

All 727 production assets were SHA-256 identical before/after browser proof (`assets.json`). No page errors occurred. Two resource-404 console messages during initial load/reload remain in `receipt.json`. PyMuPDF 1.28.2 independently checked every page: exact headings/footers, Times/Courier fonts and sizes, authored ink, dates/current-total counters, two distinct logo placements, and body between bands. PDF SHA-256: `009c0423e5c84df5f403587091acc3abc98a4296bb0e0f0224053820ae100725`.

Validation:

- Production union `f00b2fe12`: root Turbo full document selection (`document|Document|PageHeading|page-heading|page-band|ComposedPage`): 588 passed in 90 suites, zero skips (`current-document-tests.log.gz`). The preceding source had six actual Chromium contrast failures; current source fixes body-fill ancestry and preserves implicit-heading preview accessibility paint.
- Fresh actual WSL Chromium contrast controls: 11 passed across light/dark/colorful themes, zero skips (`current-contrast.log.gz`). Actual PDF operators retain canonical gray150 for implicit ink.
- B test-only correction `f87e5f936`: 19 passed, zero skips (`current-review-controls.log.gz`): actual body-fill disappearance on reset, composed CSS chart size, and DOM glyph pitch compared directly with compositor output. C/D carry this same correction.
- Final union `da2a6fc2b`: full root `pnpm typecheck`: all 111 Turbo tasks passed (`typecheck.log.gz`). Full root `pnpm lint` passed 8,337 files across four targets with no errors (`current-lint.log.gz`).
- Retained baseline/focused/lifecycle logs explicitly cover earlier sources described in Git history; they are not presented as final-head qualification.

The captured browser driver and portable independent PDF reader are included. The initial development proof with unsuitable GPU flags and earlier clipped/notification-obscured paper screenshots were excluded. There is no performance claim. Merge requires latest-head required CI, current-main integration, and all feedback resolved.

Current-head review blocker: hosted Claude/OpenRouter/OpenAI providers exhausted their quotas; the configured local PR-Agent lane is unavailable (`SELF_HOSTED_CI=false`, no endpoint or registered runner). No review marker was fabricated and no merge bypass was used.
