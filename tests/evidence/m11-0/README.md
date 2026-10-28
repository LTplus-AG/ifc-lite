<!-- SPDX-License-Identifier: MPL-2.0 -->
# M11-0 shared presentation scaffold (#7955)

Amendment authority: the orchestrator's **2026-10-28 Round 2 M11-0 task message**:
“do NOT hide SurfaceNormals from the OBJ header” and “every GEOMETRY line … stays
byte-identical; the PresentationObligationsUnmet header line gains SurfaceNormals
(in the canonical obligation order) and nothing else changes.” This explicitly
narrows the round-1 retained OBJ byte-identity requirement. The existing sorted
header order stays canonical; exact output retains full byte identity. Report
format advances to `ifc-lite.retained-report/2`. Coverage TSVs and tolerances do
not change.

The four slice modules discharge nothing. Revision-local face indices are copied
under the product budget, exclusively as diagnostics. Persistent identity is a
source-derived item/cutter/role key; kernel indices never constitute identity.
The two trailing refusal codes reserve the surface for subsequent producers.

Textures and indexed palettes: **PROVEN ABSENT** for retained-eligible products,
per the user decision of 2026-10-28 (superseding the unresolved option in §11 of
the presentation spec). The census recorded zero bindings among 131 committed
published and 94,567 heavy eligible products; all 602 palette products were
ineligible tessellated bodies. No texture/palette support is claimed. Existing
unsupported bodies still refuse; M11-A owns the pending-binding refusal producer.

The feature-gated oracle runs the production budgeted copy on a hand mesh and
requires the complete triangle-to-revision-face partition, not dense renumbering.
The mutation drops that partition. Native SDK witnesses additionally exercise
real publication, and Node/browser parity checks require the new obligation and
absence of the optional channels. Runtime logs, hashes and command receipts live
outside the repository in the owning task's evidence directory.

Performance verdict: no optimization or timing claim. Default-path identity is
a separate build/geometry requirement; the opt-in retained path adds one budgeted
u32 per triangle for revision-local diagnostics. No kernel evaluation changes.

The committed `tests/fixtures/cli-retained/m11-0-base.obj` is the real SDK output
of `f-c-extrusion.ifc` through the unmodified base Rust bundle and CLI encoder at
`021882742fba0202a8d4532e7f277f5e7e16db62` (SHA-256
`f496775572326ac8988b3320d11da9343dc9604b053d13ab021fbf265fc935f4`).
It is an output-compatibility golden, not a substitute kernel or fabricated mesh.
The actual-engine Node test compares every line and permits only the added unmet
SurfaceNormals name in the fourth line.
