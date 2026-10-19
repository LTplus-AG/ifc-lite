<!-- SPDX-License-Identifier: MPL-2.0 -->
# SDK-selected UV mate correction

Additive only after frozen2e557ea7116d3e8299dc11e8fab8eb5198c47541. The independent
pinned review identified one concrete P1: newly attached trims were required to
be owned by the matched use, while pinned SetUVTrimCurve stores them on its
SM_OT_SAME member. For an OPPOSITE matched use the correct owner is its mate
(SmEdgeuse.cpp:4547-4570). Rejecting that successful attachment entered status8.
The review found no additional blocker in the bounded fixed-read mechanism;
that conditional source review does not qualify any actual numerical result.

`src/face_extraction.cpp::canonical_uv_owner` now derives the exact selected
member from pinned semantics. It requires distinct reciprocal mates, exact
face/brep/shared-edge incidence, and complementary SAME/OPPOSITE orientations.
`verify_uv_attachment` requires the selected SAME member's raw slot to equal
the exact retained copied pointer, its opposite's raw slot to be null, the
reported getter owner to equal the expected member and the curve backlink to
match. It is used for original source trims, existing target trims and newly
attached target trims. Existing trims still require exact represented equality
and are never overwritten. Standalone, malformed or arbitrary mates refuse.
All previous unique correspondence, orientation/both mapped endpoint, exact
parameter representation, duplicate/divergent/failed-history, source seal,
revision/generation, callback, status8 and abandonment checks remain.

`tests/face_extraction_tests.cpp::box_transfer` now explicitly collects actual
OPPOSITE source uses before the first transfer into the actual empty target.
After transfer, each must have exactly one live mapped target face and exactly
one mapped edge/use of the same OPPOSITE orientation, with both mapped endpoint
vertices. The actual target must store the exact copied pointer on its validated
SAME mate, with canonical raw-slot/backlink/face/brep incidence. The witness
requires every such input to reach canonical attachment and at least one actual
opposite-oriented correspondence. No lazy trim-creation query is inserted.
Existing complete target seal, repeated transfer, closure and fixed real signed
boundary integrals remain required; a final marker follows the volume8/area24
assertions. No successful runtime integral is inferred from this source.

New stage names are opposite-use-canonical-attachments-verified and
opposite-use-complete-seal-integrals-verified. Both are UNRUN. All old negative
and independent failure lanes remain. No shared path, callback waiver, numerical
phase expansion, default/tolerance, SDK, CMake, public protocol, runtime or
paired partition change is included. Parent owns pinned closure review and
actual native/WASM execution. Full paired/interface proof and later topology
phase qualification remain held.
