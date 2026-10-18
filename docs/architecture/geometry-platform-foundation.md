<!-- SPDX-License-Identifier: MPL-2.0 -->
# Shared geometry platform: foundation status

This branch implements the shared document and execution boundary described by the
[design](../../tools/smlib-evaluation/implementation-design.md). It preserves the
exact kernel and adds a real isolated SMLib path. Full platform migration and
production activation are unfinished; the [capability ledger](geometry-platform-capabilities.md)
remains the cutover contract.

## Implemented

- `rust/geometry/src/document/`: immutable local mesh definitions, f64 occurrences,
  document identities, generation/revision validation, exact boolean evaluation,
  refusal of unsupported evaluation contracts and stale result publication.
- `rust/processing/src/retained_geometry.rs`: explicit admission of the canonical
  processing result, keeping its complete original output recoverable. Source mesh
  geometry is copied for execution; appearance, textures, UVs, source fields,
  metadata, instances and frame remain in the original result. Instanced occurrences
  share template definitions and use f64 composition of template-relative placement.
- `native/smlib-adapter/`: pinned core/API build, C ABI with owned solid/mesh handles,
  immutable boolean transactions, validated primitives, numerical volume and
  manifold queries, strict tessellation with BRep-local face attribution and
  owned mesh streams. No OpenUSD, Python or TBB enters the minimal kernel build.
- `rust/geometry-runtime/`: native serial worker client, versioned bounded IPC,
  worker-affine handles, crash/protocol poisoning, deterministic termination/reaping,
  bounded f64 mesh transfer and explicit mesh release. A bounded supervisor adds
  queue-inclusive deadlines, cancellation, automatic retirement and reaping. Exact and retained BRep
  operations stay distinct. A test exercises explicit BRep tessellation admission
  followed by exact evaluation, without automatic engine substitution.
- `rust/processing/src/authored_geometry/`: source-bound extrusion/swept-disk
  recipes reusing the canonical analytic walk, with explicit product requirements
  for omitted coverage, enclosing booleans, external openings and unsupported input.
- `native/smlib-adapter/browser/`: independent owned module workers with bounded
  admission, explicit incarnation tokens, request deadlines, poison/restart and
  deterministic disposal. Native and browser use one C++ opcode decoder; Rust
  provides the corresponding transport-neutral request encoder/response validator.
- `.github/workflows/geometry-platform.yml`: native/real Rust subprocess tests and
  the same C ABI suite under Emscripten/Node. The ordinary Cargo build needs no
  C++ toolchain or downloaded SMLib source.

The new result admission is opt-in and copies geometry buffers. It is an integration
bridge, not the final authored geometry document or a zero-copy memory solution.
No existing loader or exporter selects SMLib through this implementation.

## Production-stage extraction

The canonical element producer now separates strategy planning, geometry execution
and presentation assembly in `rust/processing/src/element/`. Native and browser
entry points are unchanged. Empty-output outcomes remain explicit: annotation
refusal is terminal, instance-only output succeeds, and a host consumed by an
opening is not resurrected by a retry. This is a synchronous production refactor,
not a suspendable durable document evaluator.

`rust/geometry/src/processors/extrusion_plan.rs` provides the first owned
production construction. The existing extrusion processor lowers once and
replays the existing numerical builder. Sampled profile regions remain sampled;
complete analytic construction lowering and the full operation graph remain open.

## Defects caught during implementation

Independent review reproduced a finite-input unit box collapsing at a large origin
while SMLib reported success. Endpoint representability checks alone were insufficient.
Primitive admission now checks manifoldness and independently expected analytic
volume before publishing a handle; regression cases cover both cancellation and
kernel tolerance collapse. Existing RTC/local-coordinate policy remains necessary.

The owned-handle tests distinguish valid empty boolean output from failure, check
that released slots never revive stale handles, and preserve both input bodies
across repeated destructive upstream operations. Tessellation checks include a
circular opening with inner loops and use upstream triangulators rather than
invented polygon fans.

## Validation and receipts

The original [feasibility evidence](../../tools/smlib-evaluation/evidence/) is retained
unchanged as experiment evidence. Foundation run receipts and source/artifact
fingerprints are recorded separately under `evidence/geometry-platform-foundation/`.
Those receipts describe the original foundation sources. Subsequent authored-plan,
protocol and supervision work has separate receipts under
`evidence/geometry-platform-execution/`; historical receipts are not rewritten.
Available commands include:

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p ifc-lite-processing --test retained_geometry
IFCLITE_SMLIB_WORKER=/tmp/ifclite-smlib-adapter-native/ifclite_smlib_worker \
  cargo test -p ifc-lite-geometry-runtime --test smlib_worker
cargo build --locked -p ifc-lite-geometry-runtime --target wasm32-unknown-unknown
cargo run -p ifc-lite-processing --example retained_geometry -- model.ifc
```

The real processing tests include the ArchiCAD FZK model and the opening-bearing
ISSUE_129 model, mapped millimetre geometry, survey coordinates and instanced versus
flat output. Missing downloaded fixtures skip explicitly; receipts identify which
files were actually present. Mesh preservation compares positions, indices, normals,
source/presentation payloads and reconstructed f64 frame positions. These checks
prove admission preservation, not direct IFC-to-SMLib fidelity.

The C ABI suites independently check mesh volume, directed edge incidence, analytic
surface placement, flat normals, source-face grouping, input preservation and owned
buffer lifetime. The real browser runner additionally checks two independent
workers, transferred-buffer ownership, bounded admission, stale epochs, malformed
commands, hung-worker deadlines and missing-WASM initialization failures followed
by restart and actual kernel recovery. This proves the isolated browser boundary,
not application packaging or a production IFC load path.
Runtime process tests use the built native executable, including independent
concurrent contexts, handle isolation, killed workers and bounded transfer refusal.

Performance qualification compares separate base and branch builds of the existing
whole-pool probe. No SMLib load-time win is claimed. The new opt-in retained admission
has additional copy/retention cost; its full application memory lifecycle is not
qualified by unchanged default-path fingerprints.

## Remaining implementation and cutover gates

1. Lower complete IFC authored geometry and operation DAGs into the shared document;
   evolve canonical element processing into plan/execute/assemble across both targets.
2. Integrate the browser dual-module transport with the Rust/WASM host and qualify
   application asset packaging; an isolated runner is not a production load path.
3. Compose bounded native worker pools, add OS memory limits, replay and
   native/Python/embedded worker distribution. The implemented supervisor enforces
   elapsed-time deadlines and cancellation; upstream tessellation allocations are
   not bounded by the Rust transfer buffer limit.
4. Preserve appearance and source lineage through evaluated face changes. Current
   tessellation IDs are local to one BRep, not stable IFC face identities. The
   boundary currently emits flat per-corner normals; analytic smooth normals,
   UVs and texture/material binding still need the existing appearance contracts.
5. Integrate edits, queries, sections, clash, all exports, retained USD/BRep and a
   versioned IFCX contract. Keep every existing exact/polyhedral capability.
6. Resolve direct-construction seams/ownership issues and qualify the complete
   authoring-tool corpus, native/browser parity, determinism, packaging, performance
   and memory. Delete superseded orchestration only after its contracts are preserved.

No existing geometry reference, determinism pin or performance baseline is repinned
by this foundation. The default geometry path retains its existing exact engine.
