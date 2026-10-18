<!-- SPDX-License-Identifier: MPL-2.0 -->
# Corrected context candidate: native scene comparison

**44/44 cases matched**, including an independent baseline repeat for every
case. These runs qualify only the corrected **288-source** candidate identified
by the [immutable manifest](../source-manifest.json), before the subsequent
native consumer test expectation correction. They do not establish that the
complete workspace test suite passed. No performance claim is made.

The shared collector was separately linked to pinned baseline and freshly built
candidate profiling libraries. Every case ran base, base-repeat and candidate in
separate one-worker native processes. The [commands](commands.json),
[library pins](library-pins.json), [build receipt](consumer-build.json) and
[final summary](native-summary.json) retain exact inputs and artifact hashes.
All 288 frozen source hashes, both source deletions and all 11 actual fixture
hashes were checked after execution; [verification](input-verification.json)
records that check. The finalizer also rehashed libraries, executables, collector
sources and retained raw records.

The 11 inputs each ran `full`, `stream`, `instanced` and `fastfirst`: bath CSG,
mapped synthetic instances, the georeferenced bridge deck, four Annex E
texture/color samples, FZK, duplex, rvt01 and wall-with-opening-and-window.
The bridge file declares IFC4X3; its directory name is not IFC5 qualification.
`fastfirst` disables upfront presentation-layer resolution to exercise deferred
styles. Exact fixture paths and mode-specific positive gates are in the summary.

Compared structured outputs include meshes and every exposed frame/instance
sidecar, IEEE float bits, UVs and texture payloads/references, metadata and
georeferencing, properties, symbolic/text results, event order, deferred colors
and semantic diagnostic aggregates. Timing and cache-work channels are retained
separately. Vector order, occurrence multiplicity, option presence and wide
identities remain distinct. Digests index actual compared records.

[Coverage](coverage.json) records observations across modes: 10,059 meshes,
558,192 triangles, 133 instances, 12 UV meshes, eight pixel textures, four URL
textures, 260 text observations, 5,436 polylines and five deferred color updates.
Positive mapped-instance, UV/texture, FZK text and deferred texture-color gates
passed. These counts are not distinct source-object counts.

The [five collector invariant tests](rust-tests.log) link the pinned baseline
libraries; the 44 paired cases exercise both actual implementations.
[Three Python comparator tests](python-tests.log) passed. The candidate-linked
[standalone clippy invocation](clippy.log) exited zero with warnings denied;
the empty log is intentional.

No layer meshes or symbolic fills were witnessed. Full-pass public aggregates
do not expose per-element hash/refusal chronology. External image-reference
matches do not prove asset resolution or GPU sampling, and the full source
material/PBR definition graph is not exposed. These cases do not qualify heavy
full-scene inputs, all consumers or interactive viewer behavior. IFCX/USD have
separate actual-consumer receipts.

Large raw JSONL/manifests and binaries remain at the exact local `/tmp` paths in
the summary and are absent in a clean checkout. Source reconstruction uses the
[parent source overlay](../source-overlay.json) and its archive over pinned
base `8acd0715a5ad266cd57808b9889f6549fbf93631`, with the listed deletions.
Rebuild that frozen scope rather than substituting subsequent source edits.
