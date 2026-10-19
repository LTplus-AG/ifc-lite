<!-- SPDX-License-Identifier: MPL-2.0 -->
# Corrected SDK WASM execution at `26354b06cc`

The source-clean Pop job completed all 281 WASM SDK compilation/link steps and
ran all eight Node/WASM CTests: five passed and three failed. Checked face
extraction and the independent destructive fault boundary pass. The lineage
prerequisite now passes its two copies and sealed numerical read, then refuses a
later MakeEdgeInFace/DeleteEdge PRE_EDIT. This does not qualify native execution
or paired partition/interface semantics.

The browser protocol case exposes a witness key defect: values rounded to zero
retain different signs in seven-decimal keys. Repair `6896c7425a` preserves the existing
grid and all geometry tolerances; its synthetic positive/negative regressions
pass, but this old run cannot qualify the repair. The actual affine chain also
remains red: a generic edge endpoint coefficient is `4.4408920985006262e-16` while
its topology coordinate is `0`. The exact predicate correctly reports inequality;
no epsilon, geometry snap or accepted refusal replaces the required positive case.

After the CTests and packaging-only SDK asset staging, curl failed to resolve
storage.googleapis.com. The shell exited 6 before Rust browser tests, canonical
WASM/types, Playwright and root typecheck. None of those stages ran. Matched
Chrome/driver provisioning is not a browser qualification receipt.

The exact command, request, receipt and full losslessly compressed output are
retained. The decoded output matches the unchanged original receipt and an
independent verified vault readback. summary.json distinguishes all stages.
Task closure is deferred while the newer strict Clippy job owns the same shared
compatibility cache; no shared cache, foreign task or source was removed.
