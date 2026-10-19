# Native finite plane boundary handoff

## Frozen independent-review correction delivery

Apply `/tmp/ifclite-plane-ce65-review-corrections.patch` to exact native source
`a0fa95edd7ad15d2d5d05425808324a55c1cd7bc`. SHA256:
`5b0a337be1de88a34da7280aa195a7221d0758df9833c89e485000080dc725f4`.
Frozen corrected source is `7c7c8a30530c9ca2a2affcb304e6e11e26198f68`.
The patch excludes inherited evidence and all foreign paths. Its nine owned
native deltas and exact before/after hashes are in
[review-corrections-manifest.json](./review-corrections-manifest.json).

The three additive correction commits are:

- `bae46b92e288aa49398e3fb36d00b2b0f1b35667`: shared context timing correction.
- `561b1038334b1bd53832b3e4c4c858fa2e9cb9fd`: non-evaluating source preflight.
- `7c7c8a30530c9ca2a2affcb304e6e11e26198f68`: preserve geometric loop closure
  validation on owned numerical solids after removing source evaluation.

The last eight-line follow-up was already in flight when the parent requested
the freeze; no further implementation expansion followed. Scope expansion
relative to the original twelve paths is limited to existing `src/copy.cpp`,
new private `src/context_metadata.hpp`, and two new test files wired into the
existing executable. No target or CTest boundary was added; the isolated poison
witness is byte-identical, with its hash recorded in the manifest.

Original independent findings and responses:

1. **Context reset and intermediate policy exposure.** SmBrep's default
   constructor at493 calls sizing setters that propagate DEFAULT into the
   shared context (SmBrep.h724+). The previous copy guard restored only on
   exit, exposing the wrong policy to MergeBrep. A private raw-metadata helper
   now restores immediately after every adapter-owned BRep constructor, before
   copy/cutter geometry work. Whole-copy/whole-clip guards restore all exits.
   Actual metadata witnesses compare source/sibling/context raw scalar bits
   and effective policy under nondefault/DEFAULT configurations. An observing
   real trim Copy checks policy inside MergeBrep then copies actual geometry.
2. **Evaluation before unmaterialized trim admission.** ValidatePointers at
   SmBrep.cpp31566-31590 evaluates present UV trims, even at LEVEL_0. Generic
   SmBSplineCurve::EvaluatePoint3274 calls GetOrCreate; header549 ignores
   failed MakeNurb, whose generic implementation5674 errors on absent data.
   Source validation now only reads existing topology/representation data;
   unknown or unmaterialized existing trims reject with status7 before any
   validator. Full pointer-report, geometric loop closure and volume oracles
   run on the owned checked copy/cutter/output. Actual present-null-NURBS and
   derived lazy-trim witnesses verify rejection, no MakeNurb, no taint and
   unchanged trim, metadata, topology and coordinates.

Pinned SDK source remains unchanged at
`c9c5979f04cea8c38213004d4f04df0dcfb40d05`; inspected source hashes are retained
in the correction manifest. Syntax-only `g++ -Wall -Wextra` passes for copy,
plane/domain and all changed/new tests. Diff whitespace checks pass. **No SDK
linking or numerical execution was performed.** Parent reports original SDK80a
ended at admission timeout, not SDK execution. No child heavy job was submitted.
All original numerical witnesses remain UNRUN, and unrelated domain findings
remain with the parent's independent review. The historical handoff below
records the original source and patch, not the corrected current source.

Implementation source commit:
`a0fa95edd7ad15d2d5d05425808324a55c1cd7bc`.
Parent base: `23d68a60f47a538dd1a369958cf1a47755adc5c5`.
Child checkout: `/home/louistrue/.t3/worktrees/ifc-lite/t3-ce65bb43`.
SDK: `c9c5979f04cea8c38213004d4f04df0dcfb40d05`, inspected in place at
`/tmp/ifclite-public-sdk-c9c5979/usd-brep`; its working tree remains clean.

## Assembly

Apply the source commit to the parent integration when its owned checkpoint
permits it. It changes only twelve listed native adapter paths. No inherited
Rust, processing, runtime browser/session, WASM, Python, imported graph,
generated artifact, observer/limit/private-driver change is included.

If native shared files have moved, transfer the five new numerical files,
`tests/plane_tests.cpp` and `PLANE_CONTRACT.md`, then apply only the incremental
hunks for `adapter.cpp`, `protocol.cpp`, `include/ifclite_smlib.h`, CMake and the
existing test main. Do not overlay complete shared files. The dedicated shared
patch below contains those hunks plus the small C ABI header addition.

- Full owned incremental patch: `/tmp/ifclite-plane-ce65-owned.patch`;
  SHA256 `3c9f9e65c8e2b3f967419a082cc246ff013c3b450de44f1508b189499c9ae301`.
- Shared-file hunks only: `/tmp/ifclite-plane-ce65-shared-hunks.patch`;
  SHA256 `a6a283d4aede91af5f11c5b4cd659f4f4ae598c4b0ac9a2d97a3f540f180c3ea`.
- [Before/after file and inspected SDK hashes](./source-manifest.json).
- [Operation, domain, packet and ownership contract](../../../../../native/smlib-adapter/PLANE_CONTRACT.md).

The patches are ordinary source artifacts, not compiled target directories.
They can also be regenerated exactly with `git diff --binary BASE SOURCE --`
followed by the manifest's owned file list. Evidence documentation is a separate
commit and is not part of that source patch. No PR or push was performed.

## Implemented and inspected

Unary finite clip opcode20/capability64, caps123; original17/18/19 preserved.
Read-only finite domain admission over analytic planar trims, generic positive
clamped surfaces with actual existing UV containment, and a separate bounded
cylinder formula proof. Cylinder records bind actual raw geometry/UV conversion
coefficients. Six checked finite faces, unchanged requested base plane,
interval-certified actual sidewalls/back, immutable checked input copy,
destructive ownership/status8, canonical Empty and actual nonempty topology
validation. Output certificate is private numerical evidence requiring runtime
sealing and the actual input lease, not caller-created authority.

Actual pinned implementation inspection found and documented disabled generic
point-evaluator clamping, affine UV trim loss, success-with-reports pointer
validation, suppressed CutBreps failure and unchecked face-copy extraction.
Those findings restrict admission; no approximate materialization is added.

New genuine SDK/C ABI witnesses are invoked after the old assertions in the
existing owned-boundary executable. They cover side/mode/volume, oblique cuts,
semantic Empty, section area, topology/normal orientation, original handles and
release, protocol bounds, real full control-net interiors, cropped/missing UV
refusals, bounded cylinder coefficients and swapped UV, finite scales and survey
placement. Affine trim-loss refusals are negative coverage. Existing five native
CTest boundaries and the isolated poison executable are preserved.

## Executed

Only lightweight checks allowed by this child brief:

- `git diff --check`: pass.
- `gcc -std=c11 -fsyntax-only -Inative/smlib-adapter/include native/smlib-adapter/tests/c_header.c`: pass.
- `g++ -std=c++17 -Wall -Wextra -fsyntax-only` against actual pinned SDK include
  directories and release definitions: pass for new numerical modules, adapter,
  protocol and new actual SDK witnesses, with no owned-source warnings.

**No SDK linking, numerical execution, CTest, module Worker or browser run.**
No benchmark/performance verdict exists. No independent heavy job was submitted;
the parent's original jobs/requests/locks and SDK tree were left untouched.

## Required remaining work

Parent schedules integrated actual SDK and module qualification from its clean
assembled source, under its existing coordinated checkpoint. A passing syntax
check does not establish any numerical witness passed. Runtime Rust/browser
issuance and acceptance adapters still need integration with P3 and common
controllers; the new C ABI certificate does not close product obligations.

Opcode21/capability128 remains design-only. A genuine paired split needs one
shared intersection, ordered actual side/Empty outputs, checked extraction and
exhaustive source/generated-interface ancestry. SDK imprint-and-classify is a
candidate, but its confused-classification continuation and CopyFaces' discarded
MakeFaceuse status require additional checked work. Independent clips do not
qualify a paired split or preserve the uncapped exterior layer presentation.

Other remaining classes: generic inputs lacking true UV containment after
affine conversion, additional specialized analytic surfaces, polygonally bounded
halfspaces, unbounded Union/full-space representation, opening/layer common
execution and whole-consumer fidelity. Actual numerical tiny/large/survey,
tangent/coincident and transformed-source preservation remains unqualified
until the parent's execution. Refusal is an honest hold, not completion.
