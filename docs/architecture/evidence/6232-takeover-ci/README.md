# #6232 takeover qualification for #6710

CI run 37101632124 failed the 1 km orthographic plate colour assertion after genuine WebGPU device loss. The original failed screenshot and the trace loss events are retained here. Geometry/pixel assertions now use the existing device-loss guard, including the colour-owner precondition. Assertion expectations remain intact. Strict GPU mode still fails on device loss; nonstrict mode only skips a failing guarded operation when actual loss evidence exists.

The unchanged four orthographic scenes passed locally (four tests, no skips). The latest normal plates run also passed both sizes. A temporary missing-geometry control changed only the owner lookup from `id` to `id + 1`: with nonstrict mode and a live GPU, the actual colour assertion failed instead of skipping. The source was restored before further work. This is an assertion/guard control, not a production geometry inverse.

Review: replacement of real Bonsai walls hosting openings now refuses before anchor preparation or graph writes. Two fixture controls preserve export bytes, child/relationship liveness, journal and allocator state. The root test run also covers the new upper-layer copy core; those copy files are not included in this lower PR.

Review: the private dev server now removes its cache and closes a created server when startup fails, preserving both errors if cleanup itself fails. The already-main evidence prose spacing findings are corrected. The formatter absence finding was disproved by executing the actual function in WSL Chrome; its output is retained. The document preview label omission is tracked separately as #6741 and is not claimed fixed here.

Standalone WSL Chrome was explicitly requested by the user. The four normal GPU tests use the repository's Playwright project; neither a local result nor an inherited green check substitutes for fresh main-base CI.
