<!-- SPDX-License-Identifier: MPL-2.0 -->
# Retained common-program continuation: required source changes

This is an **unimplemented source design**, recorded after assembly of the inner
program on parent `a969cbcaf9`. It does not add retained issuance, execution,
acceptance or final-net publication to `ProductState`. The exact Rust evaluator
remains the permanent default. The explicit source-only native and browser
consumers retain their existing contracts.

## Concrete obstruction in the assembled source

`element/session_inner.rs::PendingGeometryAttempt` now retains the actual
`GeometryProgram` across every reached request. However, its `finish` methods
still consume meshes. `program/item.rs::ItemResult`,
`program/boolean/state.rs::Value`, mapping results, `product_control.rs` resources,
layer results and opening host parts all contain `Mesh`. `inner_ready.rs` has no
retained-operation payload or retained-value continuation.

The authored plan in `authored_geometry/planning.rs` is a partial analytic view:
it unconditionally records `RepresentationCoverageUnverified` and records
`EnclosingBoolean`/`ExternalOpening` requirements without lowering those
operations. Its family-local source ordinal cannot identify an occurrence in the
common program. `BoundAuthoredPlan` authenticates that view against the actual
decoder identity, but does not manufacture a missing common request or stage.
Its weak cache must stay keyed by `decoder.execution_identity()`.

Native `worker_dependencies.rs` already provides sealed
`RetainedDependencyResult`, immutable `RetainedOperationIdentity`, actual operand
handles and f64 frames. Browser `BrowserRealization` seals a source construction;
`browser_bridge.rs` currently exposes qualification and source evaluation only.
There is no browser sealed dependency-result/Boolean API corresponding to the
native one. Adding a ticket around `ModelBoundRetainedDocument::issue` would
still publish one authored source; it would not resume the reached product.

These are missing consuming contracts, not an asset-staging problem. A retained
mesh must not be injected into `ItemRecipe::Mesh` and treated as a retained
Boolean operand: that discards object identity and switches the enclosing
operation back to the exact mesh evaluator.

## Geometry-owned plan entry and values

Extend the existing entry constructors in `inner_entries.rs` with an explicit
contract-bearing entry. Existing constructors continue to select their exact
contract. The retained entry uses the same `ProductProgram` representation and
Items admissions and the same occurrence order. It never starts from a partial
`AuthoredGeometryPlan` or enumerates supported solids as substitute products.
No new STEP IDs or loader are involved. The independently owned imported entry
needs the same source-neutral contract in its own continuation work.

The geometry-side change must add these concepts together, not merely a new
`ProgramStage` variant:

1. A program-issued logical value slot (opaque program identity + monotonic
   occurrence identity), distinct from a runtime handle. Repeated mapped DAG
   occurrences retain their separate frames and share only qualified definitions.
2. A value variant carrying that slot and admitted f64 local/source/world frame
   lineage. Exact values continue to carry meshes. Every accumulation boundary
   must understand the selected value contract; a retained slot is never an
   empty mesh.
3. Immutable reached plan operations for construction, proper rigid occurrence,
   Boolean/group operands and ordered host-opening cuts. Preserve the original
   operator, operand order, short-circuit rules, source diagnostics and admission
   order. Source capture owns the original analytic recipe, not sampled mesh
   parameters renamed as analytic input.
4. Explicit unsupported requirements for source families, non-rigid transforms,
   clipping/half-space recipes, layer slicing, textures or appearance contracts
   that have no retained implementation. Propagate refusal through the selected
   retained contract; do not enter the exact retry/fallback ladder.
5. Contract-aware mapping/cache keys and cleanup. An exact mesh cache hit cannot
   discharge a retained operation. Program logical slots do not own SDK resources;
   the processing ledger owns their sealed realizations and actual lifetimes.

In particular, changing only `ItemResult` is insufficient. The consuming edits
span `inner_{product,product_adapter,mapping,type_map,layers,voids,opening}.rs`,
`product_control/{completion.rs,completion/placement.rs}`, Boolean
`{state,protocol,operand,batch,step,work,transitions}.rs` and their source/ready
adapters. Appearance remains late, and its explicit provenance requirements
must be met or refused. Current source-only flat display permission supplies no
IFC appearance or final-product coverage authority.

The geometry crate continues to own plans and control, with no dependency on
`geometry-runtime`. It never accepts a runtime handle number, mutable
`RetainedCompletion` or caller assertion that a remote operation succeeded.

## Processing-held pending transaction

Add `element/session_retained.rs` and target-specific execution modules beside
`session_inner.rs`. These are private processing modules. An explicit retained
execution owner selects them at creation; ordinary `produce_element_meshes*`
keeps its existing exact contract. Do not make failed exact work select retained
execution or failed retained work select exact execution.

A pending transaction must hold all of the following actual values:

- the original outer `WorkRequest`, original common `ProgramRequest`, and
  program-issued logical operation/continuation; no reconstructed ticket;
- a fresh strong `Arc<()>` bound to the issued work and a private pending stage
  distinguishing issued, executing, delivered and accepted;
- the captured `Arc<OwnedMeshProductionContext>`, its context identity and source
  lifecycle; the actual `ProductOwner` reservation stays owned by `ProductState`
  with its exact validated `OwnerStamp` captured in the pending transaction;
- an immutable expected operation (construction or exact Boolean discriminant),
  ordered operand slots, actual sealed operand realizations/handles, and the
  admitted f64 frames, including the selected result frame;
- the actual runtime incarnation/object owner and captured cancellation
  capability, resource admission, diagnostic state and target qualification;
- the engine-produced reply/continuation which will resume the **same** pending
  common request after runtime validation. No public method constructs a
  successful runtime receipt or a replacement common reply from supplied buffers.

One viable handoff keeps the common reply representing reached plan admission
inside this private pending transaction. It cannot be accepted through ordinary
exact `ProductState::accept`. The geometry continuation refers only to its own
logical output slot. After a sealed runtime result is validated and installed
under that slot, processing accepts that original reply and resumes the existing
control. This avoids introducing a public raw-buffer completion constructor into
geometry. A logical slot/admission reply alone proves no runtime execution;
only processing's private checked ledger can discharge it or publish output.

Source/extension admissions remain lexical under `ProductOwner::work`. Before
awaiting a browser operation, end the synchronous owner-work scope and restore
TLS, triangle-order and borrowed guards. Keep the actual lease reservation,
source/context identity, pending ticket and owned diagnostics dormant. Revalidate
that same reservation on resume; do not re-admit a new owner for the pending
request. Cancellation uses the captured independent browser cancellation
capability, even while its worker is borrowed by an async operation.

## Validate before linear consumption

Both target acceptors must inspect the intact pending transaction and receipt
before taking either. The order is:

1. Match the private Arc ticket, exact outer/common request and pending stage.
   Reject foreign input intact without retiring its foreign runtime.
2. Validate the captured context/source lifecycle and actual decoder/router
   `ProductOwner`. Reinstall only that owner's lexical resources and diagnostics.
3. Validate the sealed target receipt's live incarnation **and actual object**.
   Native dependency results must match `operation_identity()` against the stored
   operator, ordered operand handles and admitted f64 frames. A source result
   must match its original retained request/definition/revision and source frame.
   Compare browser equivalent identities from its sealed driver result, never
   from caller-supplied integers or mesh buffers.
4. Check contract-specific capability/qualification, resource and terminal state,
   immutable frame/lineage and result-slot eligibility. Prepare ledger capacity
   before changing either continuation or pending state.
5. Install the sealed result in the processing ledger, accept the original
   engine-produced plan reply, and clear the private pending transaction once.
   Retain input realizations for every dependent operation/occurrence still
   referencing them. Rejection returns the original receipt and keeps the pending
   state available; own-source expiry can retire its captured domain.
6. Only a completed common product with every reached slot discharged may enter
   canonical late presentation/assembly and final publication. A leaf receipt
   never clears representation, Boolean, opening or appearance requirements.

Native execution can consume the existing `RetainedDependency` API, but must
capture expected handles/frames at issuance, not copy the received identity as
its own expectation. Browser work first needs a sealed dependency result with
private construction in the imported driver, actual object leases, immutable
operation identity and symmetric copy/transform/Boolean semantics. Existing
source `BrowserRealization` is not that result. Neither target gains qualification
from the other's receipt or from JavaScript transport tests.

## Residual implementation and required evidence

None of the five geometry value/entry changes, the processing pending transaction,
or the browser dependency result described here is implemented by this assembly.
The source-only native/browser consumers remain usable only under their existing
explicit contract. This document does not advertise new production APIs.

The first implementation checkpoint must connect a real reached construction
through this exact transaction and resume its original common request. Then
connect a repeated mapped occurrence and a real Boolean/opening dependency using
actual sealed operands; expose unsupported families as refusals throughout.
Final-net coverage remains withheld until representation/layer/appearance closure
is established across all reached branches.

Required behavior tests include foreign/expired source and owner rejection,
wrong stage/operator/operand/frame, cancellation between issue and execute and
during browser await, duplicate accept, intact rejection, dependent object
release and repeated mapped occurrences. Target numerical witnesses, workspace
and optimized Boolean regression, all-target Clippy, canonical WASM contracts,
root TS consumers, Python, real-scene identity/oracles and whole-pool performance
remain separate exact-source qualification. No heavy validation is authorized
under the current capacity restriction.
