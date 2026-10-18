# Inner ProductProgram integration cut

Read-only source design from root checkpoint `971a6f9acf42884ca0c3540712447785207f73e1` and its current working tree. Active sibling work may change integration files; hashes below identify this inspection rather than certify a final source cohort. No production/test edits, compiler invocations, builds or heavy submissions. Existing integrated boolean, layer and presentation changes are not treated as compiled or qualified.

## Exact missing ownership boundary

`processing/element/session_work.rs::execute` still completes an entire Primary, TypeMap, VoidedParts or PlainParts attempt in one call. Its public-router calls synchronously traverse, lower, evaluate, place and accumulate all descendants. An outer WorkRequest therefore authenticates a whole walker, not an inner operation.

Inside geometry:

- `program/traversal.rs::ProductProgram::next` immediately performs SourceAdmission::RepresentationItems using a decoder. SourceAdmission and AdmissionValue are private synchronous adapters, never exposed as pending states.
- `program/product.rs::{merged,styled}` consume next in a while loop and call router item/mapping paths. No pending item disposition or owned output destination survives return.
- `program/mapping/{merged,submeshes}.rs::advance` already owns one frame, but run drains it immediately; a plain frame calls merge_source_item/process_representation_item/textured_face_set to completion. Merely exporting advance would still hide constructor/boolean execution in a source step.
- `program/boolean/mod.rs::BooleanProgram::drive` drains frames. `step.rs` executes plane/prism/single/solid operations inline; `batch.rs` loops source admission and prism numerics inline; `operand.rs` loops owned shell lower/evaluate pairs inline. `work.rs::Completed<P>` already owns numerical results and failure records, but immediately assembles them into the live recorder.
- `program/layers/mod.rs::drive` owns eligibility parameters and a ReadyLayerSlice, but synchronously calls the whole voided host, then admits its frame, then slices and publishes diagnostics.
- `program/execute.rs` is genuinely source-free for owned constructors. The missing work is sequencing these real recipes, not adding another mesher.
- `program/resources.rs::MergedResources` owns frame accumulators, yet numerical merges occur inside the synchronous product loop. Router hygiene and placement remain outside ProductProgram, in processing.rs.

The smallest coherent cut is one nested geometry-attempt program consumed by processing. It must expose actual reached source admission, constructor/boolean/layer numerical work and accumulation completion. A WorkKind::Inner that simply calls one existing whole router walker is not this cut.

## Actual cross-crate surface and consumer

Expose an opaque `GeometryProgram` from geometry/program, with only APIs consumed by processing and the existing public router adapters. Keep its frames and family payload types private.

Concrete API roles (names may change during implementation):

1. `GeometryProgram::begin(ProgramEntry, ProgramInputs) -> GeometryProgram`: owns element identity/entity snapshot, entry/hygiene/instancing/texture policy and initial control. This constructor performs no future source walk. ProgramInputs references/owns model-level derived handles once; it is not another per-element copy of style/void/texture maps.
2. `request(&mut self) -> Result<ProgramPoll, ProgramError>` returns exactly one outstanding opaque request, completion, or terminal state. It does not accept a decoder/router or execute a callback. Pure control reductions can occur until the next reached operation, with the resource task's work admission hooks.
3. Request payloads have separate capabilities: `SourceAdmission` (owned source descriptors and required result tag), `ReadyOperation` (source-free numerical values), and `LeasedExtension` (explicit actual selected callback/RTC contract). They must be separate types; a ReadyOperation may not contain DecodedEntity, raw bytes, router/schema handles, callback closures, or an opaque whole walker.
4. `execute_source(request, &mut EntityDecoder, &GeometryRouter, &ProgramStore) -> SourceReply` is the geometry crate's lexical adapter. This is where selected processor lower_owned, source lists/transforms, cache lookups, claims and historically reached source faults occur. It may perform an explicitly described indivisible legacy extension callback; it may not drain descendants.
5. `ReadyOperation::execute(self) -> NumericalReply` consumes constructor/texture/annotation/boolean/shell/layer/merge/hygiene/transform recipes. It has no source argument. Existing exact numerical functions remain the sole implementation.
6. `resume(&mut self, reply, &mut ProgramStore) -> Result<..., RejectedProgramReply>` validates program/sequence/stage/operation tag and owned handles before consuming results or performing reached store effects. Rejection returns the linear reply intact. Completion returns the actual geometry attempt result matching the existing Primary/TypeMap/parts contract.

The real consumer is `processing::element::{session,session_work,session_accept}`. Store `PendingGeometryAttempt { coarse_kind, program, ... }` in ProductState. An outer attempt stays open while multiple inner operations execute/resume. `OwnedProductExecution::request/execute/accept` must issue/consume those inner requests, rather than call the complete geometry attempt inside execute.

Keep ProgramId/sequence separate from IFC IDs and from outer ProductExecution IDs. Repeated DAG occurrences and repeated retries are distinct operations even when they name the same entity. Extend the existing WorkRequest with an inner operation identity/tag (or nest an opaque inner request); do not create a second unrelated ticket system that processing never consumes. Only an executor-held pending slot can move the real recipe for execution; copying a small request identity cannot reexecute it. Carry actual admitted processor emitter identity separately from the contextual operation tag.

The root's public synchronous GeometryRouter entry points run this SAME request/execute/resume machinery to completion. Their compatibility drivers remain thin, but the old loop bodies are deleted. There is no selectable alternate traversal.

## Control conversions needed in the same implementation sequence

### 1. Item control and source/numeric separation

Replace traversal's synchronous SourceAdmission with a pending `AwaitRepresentations` / `AwaitWholeItems` / `AwaitItem` frame. Resolve each complete source list at the old reached point. Source replies own the admitted list; they do not admit later descendants. A failed later list reference must prevent the first child of that list from executing.

For ordinary raw/item dispatch, factor the existing `router/processing.rs::process_item_in_rtc_frame` into reached source admission and post-execution handling. Preserve: clear THIS item's pending curve/face flags; choose the actual registered instance; determine RTC benefit and raw offset at the reached point; lower through that instance; use its explicit callback fallback if lowering is None; drain the reached flags; validate indices; unit-scale; publish object-frame bounds. A recipe's `rtc_applied` route commits only when the old RTC hook produced Some. A None RTC result may permit the plain callback, unless the resource task has observed a terminal stop. Preserve alignment's initial dedicated attempt and its ordinary source-error recovery.

A `LeasedExtension` command remains an indivisible synchronous call with actual decoder/router ownership, including nested canonical and scoped-worker behavior. It is an honest capability exception, not a source-free recipe. Do not infer a builtin recipe from IFC type or configured-origin labels.

### 2. Mapping continuations become parent-driven children

Turn the current advance call into a poll returning a child request. Replace plain-frame router calls by child item-program frames. Preserve explicit merged/styled consumer modes, output ranges and path policies; do not unify them through a global visited set.

Move cache/read/claim/publish/template effects through a leased ProgramStore that uses the existing actual router stores. Completed cache entries publish at their original reached point before later source/callback work; delaying every effect until outer final accept changes observable reentry/cache behavior. Pending incomplete artifacts retain the resource task's rollback contract.

Current mapping Admission may contain a provisional template token referring to router-owned Rc/RefCell state. Adding that directly to ProductState would make its type !Send and break existing dormant transfer tests even if only one enum variant uses it. Keep router-local claim machinery in the execution store behind owned claim IDs; program frames contain no RefCell borrow/guard or Rc callback authority. Coordinate this conversion with the active resource/retained owners rather than adding another template cache. Cancellation/drop needs an explicit leased cleanup handoff; a suspended token must not secretly require borrowing a departed router in Drop.

### 3. Boolean continuation exposes its existing real requests

Do not replace conditional BooleanProgram by eager ConstructionBatch admission. Convert each inline `.execute(...).assemble(...)` into `AwaitNumerical { continuation, recipe_tag }`, then consume its typed result/failures before admitting the next source.

Split begin_boolean_step's current PBHS chain into explicit continuations: plane source -> kept-side numerical test -> only when needed Position/contour admission -> prism evaluation -> only after success unit discovery -> single-cutter operation -> reached plane fallback. Likewise split prepare_group into one cutter source/prism pair at a time. Preserve the candidate collector's speculative direct-read order, base evaluation, failure mark and deferred group rewind; source refusals and monotonic visits are never rewound.

Split WithVoids shell traversal at every lower/evaluate pair. Store operand role, shell cursor, completed outer mesh and loss flags; do not admit the next shell or discover units until its predecessor succeeds. Nested CSG keeps shared recorder ordering and existing depth-reset/path/visit semantics.

BooleanProgram owns OperandPath, active IDs, pending host and frames. Its current RestoringProgram holds a borrowed caller path solely for synchronous public compatibility; that guard must remain in the synchronous adapter or be replaced by an explicit owned return contract, never enter a suspended program. Do not reset visits or kernel budgets at each new request.

Use the existing owned `NumericalEffects`/Completed idea for replies, but remove its retained borrowed unwind target from anything that can outlive execute. A lexical execution guard can deliver reached effects on panic to the leased owner. Normal accept appends effects once into the original emitter's log; it must not flatten grouped per-processor diagnostics or drain all logs per request.

### 4. Type/layer/placement completion stays inside the attempt

TypeMap becomes a child state: admit representation/whole Items/claim; run ordered item children; resolve MappingOrigin only after the last child; then transform/hygiene/finish numerical parts. Missing or resolved wrong-type origin is identity; failed reference resolution stays a late source error. Nested mappings retain the existing merged interpretation and texture boundary.

LayerProgram becomes `Eligibility -> AwaitHost -> AwaitFrame -> ReadySlice -> PublishDecision`. AwaitHost pushes the actual opening-owner child program supplied by the active opening task; do not introduce a ReadyOperation that calls process_element_with_voids. Frame admission remains after successful, nonempty host. Preserve diagnostics, fewer-than-two slice fallback, material IDs and layered early-return hygiene.

Move the existing router source-hygiene and placement completion into typed attempt transitions. A merged product preserves combined/rebased/far frame groups and the single-instance eligibility count. A styled product preserves UV-sensitive IndexOnly cleanup and ordered submesh placement/weld. Source placement admission and transform arithmetic are distinct steps, with exact current re-read/cache behavior. Do not memoize an earlier placement merely because its entity ID is equal if a reached extension may have changed decoder state.

### 5. Processing owns attempts and late presentation

Keep existing coarse Primary/VoidedParts/PlainParts/TypeMap strategies as attempt outcomes, not indivisible executor payloads. Only a completed inner attempt can feed session_accept's corresponding recovery branch. Primary-empty/noninstance versus instance-only success, refused annotation terminal, consumed-by-opening host and ordinary retry remain distinct. Discard retry CSG records only at the existing failed-primary boundary; final drain remains after fixed colours and before hash publication.

The integrated presentation_source admission must remain late, after completed geometry callbacks, with orientation/normals before submesh style reads. It then yields the existing decoder-free ReadyPresentation for consumption. Type ancestry runs once even for empty parts. A future step can schedule presentation as an inner ReadyOperation; there is no need to recreate its numerical funnel or expose the model context inside the packet.

### 6. Delete superseded complete drivers after all callsites use the machine

Replace product merged/styled while loops; mapping run-drains; TypeMap.run; BooleanProgram.drive drain plus inline numerical dispatch; LayerProgram.drive host/frame/slice drain; and session_work's complete public-router attempt calls. Preserve only thin synchronous public adapters that drain the common request machine. Delete orphan methods/adapters in the same integration. No family-specific activation or second mapping/source path.

The active opening/source-coherence/resource/retained tasks supply their own children/stores/contracts. This cut consumes them, without reimplementing their algorithms, source factories or accounting. Full cutover requires every coarse attempt route to enter the same inner machine; leaving an opaque opening walker is an explicit integration hold, not completion.

## Poll ownership and guard rules

Outer ProductOwner lease and model context remain stable across inner requests. A live inner program cannot migrate routers/decoders; only existing dormant transfer is preserved. Owner/config/source validation happens before source execution and before accepting a reply, with the existing trusted synchronous mutation commit after reached callbacks. Reply identity never authorizes rebasing.

For each execute or accept poll, install/restore the SAME owned ElementState budget, pending diagnostics, degenerate tally, triangle-order mode and resource/source capabilities. Keep claimed unsupported-source policy as owned booleans installed lexically per frame. Never retain ActiveScopes, PollScope, TriangleOrderScope, ExecutionWork, ExecutionSourceScope, a RefCell/Mutex guard or borrowed NumericalEffects sink across suspension. Capture only their owned state/handles. A new operation resets only budgets whose old numerical operation did so, not cumulative element/operand work.

Sparse processor dispatch capture must cover the actual selected admission/callback once, not be recreated as a family label. Merge the trace into the owning outer attempt while preserving unique-token semantics; a constructor numerical reply carries the identity of its admission rather than entering an unrelated new processor.

No kernel/diagnostic TLS automatically transfers to a scoped worker. Preserve current borrowed custom callback authority; use the active resource task's actual source-chain accounting/terminal contract rather than worker-local account inference. A terminal ResourceRefused/Cancelled cannot be mapped through SourceFault skip/.ok/retry branches.

## Required behavior gates for this cut

- Pause between whole representation admission, whole Items admission, item lowering, numerical result and next source read. Real callbacks repair a later representation but cannot repair a bad sibling in an already admitted whole list.
- Wrong inner program/sequence/stage/result/emitter/owner/context replies are returned intact before any accept-time merge/hash/append; duplicate execution and double accept perform no effects. Replay an identical IFC ID at two actual occurrences successfully.
- Suspend at merged/styled mapping entry and cache hit, after child output, before transform/retag and before source publish; preserve cache-read order, sticky failed styled IDs, merged cleanup/truncation, first claims, exact transformed range and texture/instance eligibility.
- Pause at PBHS kept-side, failed prism, deferred group, solid operation and WithVoids shell boundaries. Verify source refusal order, typed unknown operator recovery, bool grouping/rewind marks, exact result flags and monotonic visits/budgets against the current canonical adapter.
- Pause layer after host callback mutates placement but before frame admission; distinguish empty host from ineligible layer and insufficient slices. Pause TypeMap before late wrong-type/unreadable origin and before late colour lookup.
- Abandon/panic between replies: no retained TLS/borrow guards, no accidental ambient reports, no stale template marks; completed independent caches survive and incomplete claims clean through the leased store. Dormant session remains Send; live owner replacement still rejects.
- Real-model complete-scene comparisons include Mesh frame/origin/local bounds/transforms, normals/order, UV/image payload, geometry/material IDs/classes, material names, metadata, instance transforms, symbolic data, hashes/volume/closure and grouped diagnostics. No green claims can transfer from the prior coarse-work source.

This is an implementation cut for real inner execution and consumed replies. It does not itself establish arbitrary asynchronous transport, cancellation publication policy, process memory limits, external source authentication or retained-engine activation; those remain separate contracts and qualification gates.

## Inspected SHA256

- `rust/geometry/src/kernel/budget_state.rs`: `f5d6db839fecf84444c429443c0cf3f7e9840e6de3a82a0633ee00c07b4ce1af`
- `rust/geometry/src/processors/boolean/operand.rs`: `c6af644a3baeb0653bd1b83bce1c4860f85b838e6408e30bb9effb5cef8834c7`
- `rust/geometry/src/program/annotation.rs`: `a4e2acbe6c2071c668de632cdd7d83b2ae63aa7d1d04d597e456863d003c31d6`
- `rust/geometry/src/program/boolean/batch.rs`: `faf69ef08feeb4717146114ecc9912c91840366dc9e92204b93b19d7f3a5966c`
- `rust/geometry/src/program/boolean/mod.rs`: `46f21a894b78c2d30b718ff8e83e3c9ea89fa1b3ea5258b1bdd320d643c65531`
- `rust/geometry/src/program/boolean/operand.rs`: `5078f2e9511ac5640f55c078ab59901488a72191718cd009c07b37aad5805fb8`
- `rust/geometry/src/program/boolean/state.rs`: `978ed3cf350cb8a3428a9d5449957653b00192f3a490f7d6fa3868ffcd54889a`
- `rust/geometry/src/program/boolean/step.rs`: `cd6043ebc46c444dc25cc1723561bb0175dd7315341c6b1162a611e9fbe23157`
- `rust/geometry/src/program/boolean/work.rs`: `eb5f88d6642516dadd7a49cbf8ff140ae3ac3eccb1b3bfe2daac9ddfcbab6d1f`
- `rust/geometry/src/program/constructor.rs`: `31c5d79891d006360b800de57097f8449a8bee32fef484f7601f8f7f62f762f2`
- `rust/geometry/src/program/execute.rs`: `1257de2788d2b5dc2a74d22b6dbedd75aad2aa1b02290a6e9f7f61ce28ec06d7`
- `rust/geometry/src/program/layers/mod.rs`: `15aeb3f7963bb21a775e73da25227d7c2edb53cc61bb1d2963077a97c262ef3c`
- `rust/geometry/src/program/layers/planes.rs`: `8e6fd9faf00f0a14baba69ce6b8bf9907850a3305c0c5e71d4b06ac341017952`
- `rust/geometry/src/program/layers/slice.rs`: `961dedcb694c48e97abee534fe9443501804e58e15c6256dddcf8e8e2b689d41`
- `rust/geometry/src/program/layers/source.rs`: `3f2c5d879c237914bff71dc016c6ad098f8dc7486d5201b07506c5900d2e08a0`
- `rust/geometry/src/program/layers/stack.rs`: `df348423647c6c390f346c3934034fc17b94c1612e5d55c6f64affea7108984d`
- `rust/geometry/src/program/mapping/merged.rs`: `0746d1a10959222bc443ebc7b2756c24da11bbba5d7fac002946ac02641b5af9`
- `rust/geometry/src/program/mapping/mod.rs`: `760df450a8a548bded5074e644e4813c266f57645d58a96845cf5d8444e9aecf`
- `rust/geometry/src/program/mapping/occurrence.rs`: `762be993f6757549bbfe60e1c023cd529185919b560279366815acfaaf50df59`
- `rust/geometry/src/program/mapping/submeshes.rs`: `f43f882ebeb651176580808e5ace5902c66eaf20201c7dd796ebe4602c29cdb6`
- `rust/geometry/src/program/mod.rs`: `179ecbc859960ab3366a52c4acb4989ba270c6ea830157e2f4a80a215657a6a2`
- `rust/geometry/src/program/opening.rs`: `7b8d57f7afbb7130c074a4bedfe280afc963e6768714c242444a460fd2668aea`
- `rust/geometry/src/program/opening_bounds.rs`: `1fb443206fe39820ad1df9985f31193e7764a1f6d1b2db24f3861808e25e2073`
- `rust/geometry/src/program/product.rs`: `050b7622fd42dbfc6f71446c56d6e35899bfdb73a779c73aa552782c84cf098a`
- `rust/geometry/src/program/resources.rs`: `97825cdddb2943eb8ea26dc9fb2dc25b471f963d4c4517cbf82877c2a91b3bc0`
- `rust/geometry/src/program/source.rs`: `76dbcd81bce47e04ab8d8b160ab19e183b2f869ef466be2308c5d30a0f4d3428`
- `rust/geometry/src/program/traversal.rs`: `203af4f26949eb5ee06fe10b5cc801c136fc31fba4a89f9b0bbef1bd1ec5b797`
- `rust/geometry/src/program/type_map.rs`: `382c54778a54018ec2f9ffc5d43b1e1d722c815ab7fd99b6404c3f0c0582b3cf`
- `rust/geometry/src/router/layers.rs`: `2881252a8c75b4e3f0abbc2308a8076a3f3230727cb1b863a26f5b471c17ad2c`
- `rust/geometry/src/router/processing.rs`: `383171f8f767c59e7ac813be3a96bc49c5bc90fc987f8fa40e56721e9bfa0825`
- `rust/processing/src/element/owned_session.rs`: `4c6dcfaa742fea5e812f41a51882e3e77b540fa3e02a83531613fa502a2b3f73`
- `rust/processing/src/element/presentation_source.rs`: `8ef40fbb2125406595873e63e395100b2376345c582fba3202298549bb6b119b`
- `rust/processing/src/element/session.rs`: `ddb799ae62895725b24c7e561a5ea0a528afd1962063ec2b59cc4848ba22afed`
- `rust/processing/src/element/session_accept.rs`: `3009de0d044d3623240c7891afcb6982b48debbd49d3a89c757b97cd2b57e410`
- `rust/processing/src/element/session_protocol.rs`: `6cde3eaa6b44878b95a16e9d48436298d226b55349160c1e1f753e93657cff4d`
- `rust/processing/src/element/session_state.rs`: `c6161e45da7309b9f47e76956384eba9f0f2be5c5614facab4db3ef57d3f0b95`
- `rust/processing/src/element/session_work.rs`: `e22535184636846eda07975ae2e1e5a1b11dcdbe2883d34d2d4ef132677721ad`
