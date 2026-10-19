<!-- SPDX-License-Identifier: MPL-2.0 -->
# Retained openings frozen719 source review

Candidate `719a7e4b2ad6ba8376c369a5fb6467950e66df21`, exact base `68da7b8a966e0972fa41a0c5d9ab3a48ede19a4c`. Immutable Git objects only. All24 changed paths and11 called-path dependencies are pinned by Git blob and SHA256 in `ifclite-openings719-review.json`. No source edits, build, tests, SDK/browser execution or jobs. Later child hardening and parent807a are outside this verdict. The parent's baseline workspace result does not qualify these changes.

## P2: no-related Empty host completion reports false

`rust/geometry/src/program/inner_voids_retained.rs:93–96` handles PlainParts by moving values and setting related=0 without computing empty_host. The flag remains its constructor false. BodyParts/BodyStyled computes values.iter().all(is_empty) at line98. Consequently the public retained_voided_parts entry, with no related opening ids and an actual semantically Empty host, completes with an Empty output but opening_completion.empty_host()==false. A product with no source values has the same inconsistency.

Compute this fact before moving the values in PlainParts too (or consistently at the common host admission boundary). Keep the no-related branch free of opening source reads. Extend the real Empty-host fixture to the no-related/index-absent case and assert Empty values, completion true, zero cuts, related0, no grouping deferral, no reached cutter. Do not infer Empty from display bounds. This does not presently cause a wrong cut; it is a concrete incorrect new public completion fact.

## P2: retained classification allocates unused diagnostic capacity without admission

`program/openings/mod.rs:69–70` first constructs the shared classifier and only afterwards selects retained mode. `openings/classify.rs:54,65` allocates diagnostic Vec::with_capacity(ids.len()) in that constructor. The retained branch never emits those mesh classifier diagnostics; it finishes via RetainedClassified instead. Thus this newly reached retained allocation scales with the file-controlled relationship list and is neither charged to live_bytes nor necessary. Charging the copied ids earlier is a different, smaller backing and does not account for this Vec.

Select the retained construction mode before allocating that buffer and leave it empty in retained mode, while preserving the exact-mode constructor's allocation/admission timing. Alternatively admit the real backing before allocation if it gains a real retained consumer. Do not allocate first and then clear/shrink. A real-source bounded execution with repeated opening occurrences should exercise the reached classifier boundary under a finite live-byte limit and assert typed refusal before any genuinely required unadmitted growth; retain the existing independent work/fanout guard. This is a specific reachable backing gap, not a claim that all SDK heap is accounted or that Compatibility must enforce a new limit.

## Traversal and source semantics inspected

The extension remains in the existing VoidControl, OpeningAdapter and OpeningControl/Classifier. Exact branches remain selected when retained=None. Existing source decode, bulk relationship-list selection and host-before-opening control are reused. Retained classifier refuses reached malformed required source instead of recovering it into an empty cutter. Original grouping probes are deferred before the mesh-only metrics/bounds/group numerics; the implementation does not first execute a speculative grouping attempt or concatenate cutters into a union.

All opening bodies are admitted in original occurrence order before the first cut, matching the pre-existing context-before-cuts boundary. Each host logical value then receives each opening value as an ordered Difference. Repeated mapped occurrences remain real values, and repeated cutters for another host part reuse the same admitted occurrence without globally dropping geometry. Each cut provenance binds product, original host slot, requested opening id and opening/cutter ordinal beside the immutable expected operation. A successful preceding cut remains in the processing ledger if a later admission or acceptance stops.

Body all-Empty gates skip context creation entirely, so malformed late opening source is unreached. After an actual accepted cut empties a host value, subsequent cutter numerics for that value are skipped. The context was already admitted at its original reached point; the implementation does not falsely promise that later opening records remain unread after such a cut.

The layer entry preserves its reached eligibility check, then explicitly refuses an eligible retained layer rather than executing exact layer mesh work or silently dropping layers. Unsupported custom mesh-only processors remain retained refusals through the existing typed constructor selection. Their full callback/diagnostic compatibility is explicitly unqualified; those residuals are not completed coverage. Exact numerical tolerances/kernel and existing numerical bodies are unchanged by this source increment.

## Frames, transaction and completion ownership

Host and opening bodies use the same ProductCompletion placement path. Source units and original solid/profile transforms remain in authored construction receipts, with f64 mapping/product occurrence frames selected once. Generic existing sealed Difference execution consumes ordered live left/right dependencies in their actual frames; no synthetic authored cutter recipe, display mesh operand or caller-built positive runtime receipt is introduced.

The new numerical cut is emitted as the original ReadyPayload::Voids branch. Its reply contains the exact expected output slot. ProgramReply::bind_retained_outcome now descends through Voids and Opening wrappers, either binding that exact direct cut slot or continuing to the original nested Boolean reply. A foreign slot errors before mutation. The processing acceptance path remains the existing ticket/stage/context/source/owner/input-handle/frame/definition validation; no new weaker acceptor was added. Actual semantic Empty is written before original linear reply acceptance. Foreign/cancelled work stays intact according to the shared pre-existing rejection boundary.

Only the terminal RetainedVoided output removes OpeningClosure; intermediate SDK successes do not. MaterialLayers, IfcAppearance and PersistentFaces remain, and final_product_available is not asserted. Manifest extraction into session_retained/manifest.rs retains the prior definition liveness/runtime-generation and unique occurrence/discharged-definition checks; the factor does not add a second authority or numerical executor.

The new state/context/output/header growth and cutter value try_copy calls generally follow the captured account and shared retained walk. Resource stops propagate through typed source/numerical replies, and no RefCell/decoder/TLS guard is stored in the new suspended state. The specific classifier diagnostic backing exception is above. No whole-heap or asynchronous publication qualification follows from these source observations.

## Test coverage and limits

Four geometry source/control tests use the existing overlapping-opening fixture and check host-before-context order, correct cutter definitions/slots, cancellation, malformed required source and zero-related eligibility. They explicitly do not fake SDK acceptance. Six native SDK-gated tests and four actual Worker tests cover overlap, repeated mapped cutters, real Empty host laziness, wrong ticket/cancellation with retained original reply/prior ledger, reference geometry and the voiding-trap model. These tests are UNCOMPILED/UNRUN.

The overlap test uses a separate unchanged exact process_geometry oracle plus closed/manifold/volume checks. The voiding-trap witness asserts index validity and positive/manifold geometry; it does not prove byte/shape/appearance equivalence. These are honest partial oracles. Additional missing execution coverage includes the two findings, actual opening resource exhaustion/source-chain expiry, placement/unit/RTC variants and the declared grouping diagnostic/callback policy gaps. No existing SDK or Node receipt substitutes for actual assembled opening Rust/browser/SDK qualification.

## Integration

Preserve parent807a/current resource, boxed reply and retained-walk fixes when composing the24-path increment. Do not overlay unrelated old child modules. The frozen source has no scoped ownership bypass or alternate walker identified beyond the two concrete corrections above; compilation/type/Clippy/real SDK behavior remains unverified.
