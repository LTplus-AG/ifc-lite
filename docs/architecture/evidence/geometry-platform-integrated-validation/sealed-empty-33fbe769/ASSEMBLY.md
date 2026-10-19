<!-- SPDX-License-Identifier: MPL-2.0 -->
# Sealed numerical empty outcome delivery

Base: `ecdfb58675`. Implementation: `7b9a25fe84`; execution-obligation tests:
`8b07b59259`, `47ac5a5bfa`. This is an implementation delivery, not SDK execution
qualification or full P2 product preservation. The exact/default kernel is unchanged.

The C ABI extension is `ifclite_smlib_is_empty`, opcode **19**, capability numeric
**32** (bit 5), unchanged ABI/protocol version 1. It reads the actual retained
`SmBrep::IsEmptyModel() const`. The pinned public SDK is
`c9c5979f04cea8c38213004d4f04df0dcfb40d05`; the implementation at
`source/SMLib/src/SmBrep.cpp:11503` checks absence of the infinite region, faces,
edges and vertices. No SDK files were changed. No volume or display-buffer
heuristic establishes emptiness.

Native tessellation queries its actual solid before meshing. The private browser
driver queries its actual result before sealing. A semantic-empty solid requires
all six mesh metadata fields to be zero. Nonempty requires positive vertices,
triangles and source faces; topology/failure counts must be zero. Adapter meshing
also refuses a nonempty solid with no tessellatable faces or no triangles.
Construction remains nonempty. Empty Booleans retain their real SDK handle and
can be used by later operations if the backend supports those operations.

`NumericalOutcome` is descriptive; it cannot construct a result. Native results
expose read-only `outcome()` / `is_empty()` from their private runtime mesh.
Browser results hold a private outcome, rechecked against buffers before sealing
the Rust receipt. Consumers must still validate live leases and operation identity
before linear consumption. No geometry/common or processing contract was edited.

## Composition with the affine delivery

Apply the incremental commits above to the exact base or compose their hunks with
the separately reviewed affine delivery. Do not replace entire shared files.
Preserve affine opcode 18/capability 16; the final capability mask includes both
16 and 32. Preserve the affine checked-copy/MergeBrep helper and every caller.
This delivery does not edit copy implementation, dependency input arms, or lineage
variants. Keep affine Source/Result/Affine input types and Definition/AffineCopy/
Placed Arc lineage intact. Add the private browser outcome field to the Boolean
result construction; affine result construction must also obtain the same actual
solid/metadata classification before publishing a numerical result. The affine
private driver's seal call must pass its deliberate empty-admission policy; Boolean
calls pass `true`, construction calls pass `false`. Source emptiness stays strict.
Preserve the dispatch observation and caller-limit fixes at 9be/6735/ecdf.

Native `RetainedDependencyResult::Drop` still retires its entire worker. This is a
concrete blocker to independently managed result-drop leases. The native witness
keeps all results alive, and checks only explicit handle release plus operand
usability; it does not qualify independent result Drop. The browser witness does
exercise per-result Drop, but remains UNRUN. No new retirement-on-Drop was added.

## Validation and execution obligations

Executed locally on Pop without heavy admission: private-driver protocol/lifetime
fixtures **8 passed, 0 failed**; Node syntax checks; targeted Rust parse through
`rustfmt --emit stdout --config skip_children=true` (no files formatted); Python
fixture AST parse; `git diff --check`. See `driver-fixture.log` and source hashes.
These are refusal/protocol/source checks, not SDK numerical evidence. An existing
fixture assumed the upload facade exposed `allocate`; it now selects its own fake
peer by incarnation. Fake query values prove negative refusal only.

UNRUN on this source:

- Native C ABI owned-boundary tests, including `empty_tests.cpp` wired into the
  existing `smlib_owned_boundary` CTest target.
- Actual Node WASM and browser Worker C ABI empty witnesses in `runContract`.
  Both existing Node/browser entry points and real dependency qualification invoke
  this shared contract; a capability bit alone never opens qualification.
- Rust native `actual_sdk_sealed_empty_boolean_identities_preserve_independent_operands`.
  Set `IFCLITE_SMLIB_WORKER` to the rebuilt pinned adapter; absent SDK skips are
  not passes. This witness uses source-driven retained extrusion receipts.
- Actual private-browser `actual_browser_sealed_empty_boolean_identities_and_independent_leases`,
  with rebuilt/staged canonical `/smlib` assets and wasm browser runner.
- Native malformed-metadata refusal/retirement and protocol encoding tests.
- Workspace tests, strict all-target Clippy, assembled browser build, product
  continuation consumption and full P2/P3 preservation. No performance claim.

Actual witnesses cover disjoint intersection, complete subtraction, empty-empty
identities, both-order empty/nonempty identities, positive volume preservation,
metadata consistency and independent operand usability. No tolerances/pins were
widened. Native and browser acceptance remain separately unqualified.

At startup Pop was reachable but refused admission with guard **78**; PC and Mac
were disabled. Parent owns the existing root validation request; no duplicate or
heavy SDK job was submitted by this child. Source-only publication is not final
product acceptance. No PR, push or upstream SDK edit was made.
