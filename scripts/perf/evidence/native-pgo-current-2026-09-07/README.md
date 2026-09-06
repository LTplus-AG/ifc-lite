# Native PGO processing-probe qualification

Fresh current-source native profiling qualifies about 9.81% lower aggregate processing-call time across 27 models (9.97% on 22 held out), with exact covered geometry fingerprints/counts in all 135 pairs. This is not an HTTP endpoint or browser benchmark.

The largest model has an unresolved 5.27% median-time penalty despite a faster median paired ratio. Whole-process physical footprint rises 1.39% in aggregate. No no-regression or production-ready claim is supported. Actual-server artifact qualification is a separate next step.

`results.json` contains sanitized labels, numeric results, cohort definitions and source/artifact hashes. It excludes private fixture paths/names, raw geometry, property data and user filesystem paths. Raw evidence remains private. The lesson: compiler profile training can improve common native paths broadly, but a probe win does not transfer automatically to server features, allocators, targets or browser WASM; retain largest-model and memory counterexamples.

The measured pre-squash commit remains recorded unchanged. Public commit [`e40992485`](https://github.com/LTplus-AG/ifc-lite/commit/e40992485dd2a0c845225be237c65fd12603d689) has the identical complete Git tree `497a6155b289d50f083045c12212d119af2bd6f3`; `results.json` records both identities and the tree comparison. Every aggregate now lists its exact member labels, so historical, expanded and independent-large cohorts can be recomputed directly.

The 263 MB model’s CSG failure census varies across runs: baseline values are 194, 195, 197 and 198; candidate values are 194, 195, 196 and 197. Covered ordered geometry fingerprints and counts still match in every pair. This diagnostic variation remains a separate limitation, not a claim of zero or identical CSG failures.
