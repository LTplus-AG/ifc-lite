<!-- SPDX-License-Identifier: MPL-2.0 -->
# Checked face transfer increment assembly

Apply only this commit after `1afd9927873b98a9b4873acfff441c1c776534cf`, which
follows frozen ef2 and9d5. Never reapply2915 (already integrated as03f8).
`summary.json` contains exact source before/after SHA256 and unchanged local-base
pins. Evidence files are intentionally outside their own self-hash inventory.

No SDK changes/overlay, C ABI, protocol, public root authority, Rust/JS, fixture,
qualify.sh or tolerance/baseline changes are included. Preserve the parent's
latest eee60 `--rust-consumers` and independent failure aggregation script.
The local qualify.sh hash is only an unchanged-local-base pin, not a claim that
this checkout contains the parent's newer script. Apply this additive delta to
parent source; do not overlay the whole native directory.

CMake adds one private implementation source and one native/module witness
executable with two independent process lanes, seventh/eighth CTests:
`smlib_checked_face_extraction` and `smlib_face_extraction_failure_boundary`.
The original five and sixth retain their names and independent executables.
Parent qualification must reconcile all eight outcomes independently; no child
job was submitted. Both fleet hosts reported guard78 during this work.

Validation performed: C++17 `-fsyntax-only -Wall -Wextra` for copy, ledger,
ledger events, extraction and all associated original/new witness sources;
immutable pinned SDK headers as system includes, SM_NO_DEBUG_CODE,
SM_NO_GFX_OUTPUT_CODE, NDEBUG. No owned warnings. `git diff --check` passes;
SDK revision/status/diff metadata remain clean. This does NOT compile SDK object
code, link, configure CMake, run CTest or establish numerical/callback behavior.
All actual native/module/SDK witnesses are UNRUN. No performance claim.

Read CHECKED_FACE_EXTRACTION.md for exact contract and source-backed blockers.
This is a checked status/latch/live-map/fragment-ancestry transfer prerequisite.
It does not certify full partition, region material state, opposite caps,
complete shared interface, opening regularization provenance or atomic paired
publication. Operations21/cap128 and layer closure stay unavailable.
