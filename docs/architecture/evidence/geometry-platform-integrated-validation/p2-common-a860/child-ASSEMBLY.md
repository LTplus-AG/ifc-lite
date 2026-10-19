<!-- SPDX-License-Identifier: MPL-2.0 -->
# Common retained operation checkpoint

This is an incremental source handoff, not qualification, release readiness or
final-product completion. No Rust build/test, SDK execution, browser witness or
performance measurement was run by this implementation session.

## Immutable source and layers

Exact base: `2deba6d5dd1034eecc6b9f9b83c03449d22e78cd`.
Source checkpoint: `98e441819d` (full identities and SHA256 records are in
`source-manifest.json`). Apply incremental hunks, never whole-file overlays on a
newer parent. The ordered source layers are:

1. `3aafa73f73`: the separately authorized additive TypeMap reply forwarding method.
2. `818a51829a`: common construction/affine/Boolean operation nodes and processing
   transactions. This is the original frozen independent-review checkpoint.
3. `c8b05e05f8`: preserve typed resource first faults when outcome binding exhausts
   work, before any linear common acceptance; includes an SDK-gated regression.
4. `d788eef544`: shared root-owned traversal ancestry/work bounds across common
   controller children, with source-driven guard regressions.
5. `98e441819d`: preserve typed resource stops at common ready/affine admission
   and failed processing issuance, with source and SDK-gated regressions.

The manifest pins every changed source file before and after, and every layer's
incremental patch. The complete source patch excludes metadata-only assembly
records (`e785256d68` preserves the previous record generation). Compact patch artifacts are in
`/tmp/ifc-lite-retained-d840a7f5-delivery/`; regenerate from the pinned Git objects
if that temporary directory has been reclaimed. The earlier frozen
`source-checkpoint.json` and its patches there remain unchanged.

## Contracts in this source

Geometry owns logical operation/occurrence identities and the reached common
continuations. Processing owns original request/reply, source/context/owner,
ticket/stage and sealed native object/frame/input/operation binding. An ordered
batch discharges every physical affine result before consuming its original
mapping reply. Boolean outputs have operation identities and no fake source
construction recipe. Actual sealed Empty classification updates only the
original matching common numerical reply after intact validation.

Source dependency frames are accumulated forward in f64; no inverse/source-frame
round trip authenticates an input. Proper rigid source placement remains metadata;
nonrigid placement issues a physical affine copy. Runtime refusal stays a gap.

The existing BooleanProgram spine, Steps and mapped GeometryProgram children
carry retained operands and results. Authored binary order is preserved; a
multi-part representation is not implicitly unioned into a Boolean operand.
Halfspace/clipping refuses with its finite-exact-primitive residual; there is no
giant-cutter approximation or engine fallback.

Reached source reports remain in the controller's pending log while an external
reply awaits its runtime receipt. Shared receipts retain their captured resource
account when they outlive execution. Outcome binding retains typed first faults
and the original reply/ledger on refusal.

The traversal repair uses immutable path ancestry per occurrence, bounded by
`ifc_lite_core::MAX_MAPPED_ITEM_DEPTH`; sibling occurrences inherit their parent
path independently. The shared monotonic work bound is the existing
`MAX_OPERAND_VISITS * MAX_MAPPED_ITEM_DEPTH`. It covers request/control progress,
copy, merge and cache fanout in Compatibility too. The same Boolean wrapper
inherits the same occurrence; actual mapped/item children fork ancestry. Lexical
selection is restored before every returned packet. Polling does not debit or
poison an unrelated ambient resource account. A terminal root cannot finish as a
partial success. There is no global visited set suppressing real DAG output.

## Required composition with the styled/type-map sibling

The sibling `2fbb172ddb` and parent cancellation repair `bf9f12270d` are absent
from this task's exact base. Preserve their complete implementation when composing:

- Keep owned `presentation: Vec<RetainedPresentation>`, its admission/copy logic,
  TypeMap placement stage, presentation bindings and remaining-requirement backing.
- Keep `placed` delegating to sibling `place_in_place`. Move this increment's
  affine validation, root work charge, unique slot allocation and forward
  `world_from_source`/`object_frame` update into `place_in_place`. Preserve the
  sibling's presentation data in every value copy and operation output.
- `copy_values` must copy both placement and presentation vectors with the
  sibling's existing byte/header admission. Also charge presentation element work
  to the shared traversal allowance beside the placement work charge.
- Keep the sibling ReadyPayload::TypeMap retained arm; its control-only operation
  collection becomes `Vec::new()`. Keep `value()`; `construction()` now returns
  `Option<&RetainedConstruction>`, and `kind()` exposes ordered operation inputs.
  Common admissions return an ordered Vec of operation nodes.
- Preserve the authorized TypeMapReply::child_reply_mut additive method. Mapping
  and product envelope forwarding are additive too. Outcome binding walks these
  original envelopes iteratively and charges every envelope.
- Initialize `retained_walk` in sibling root `retained_submeshes` using the element
  id before moving the element. In `retained_styled`, obtain
  `RetainedWalk::child(item.id)?` before controller creation, then install it.
  In `retained_type_map_id`, obtain `RetainedWalk::child(id)` (it creates a fresh
  root when no parent scope exists); install it on success, or retain the typed
  error as terminal output and remove its controller on failure. Check that
  root terminal before `finish_retained_type_map` can return a plan.
- This base's MappingReadyWork::admit_retained handles Merged only. Preserve
  sibling Styled controls during assembly. Styled Range transformed values need
  the same physical bake extraction/ordered issuance as merged placement; do not
  accept the base's Styled refusal as closure. Preserve source-local captured
  templates before placement, authored ranges, presentation and original replies.
  Propagate bake errors with `retained_admission_error` so resource stops cannot
  turn into UnsupportedRetained before processing sees its captured first fault.
- `session.rs` changes here only the admission result Option to Vec and its empty
  initializer. Retain the parent's entire entrance_stop first-fault repair in the
  reply acceptance body. No native runtime/lease/driver file is changed here.

These assembly obligations are explicit blockers until implemented and reviewed
on the parent's assembled source, then exercised there. This child snapshot does
not claim that sibling composition already happened.

## Checks and qualification

Syntax-only pinned rustfmt parsing covered all 38 changed Rust source files;
`git diff --check` passed. Metadata gates `check-module-size.mjs` and
`check-refwalk-guards.mjs` exited zero. Refwalk reported 12 existing fanout-review
warnings; its lexical guard detector does not prove the new guards' behavior.
These checks are not compilation, numerical execution or performance evidence.

Actual SDK tests use only `IFCLITE_SMLIB_WORKER`, and explicitly skip when absent.
They were not run here: their current status is UNEXECUTED, not passed or skipped.
They exercise A-A/disjoint Empty, chaining, repeated operands, affine batches,
swapped/missing/wrong-operation outputs, stale operands, context/stage/cancellation
and original-resource stops, typed nested binding exhaustion, typed affine
admission refusal before issuance and no publication.
Source tests cover mapping/Boolean frames and identity, mixed cycles, long
acyclic alternating chains, fanout and legitimate repeated DAG occurrences.

Parent-owned native Empty classification changes and all historical SDK results
retain their own source identities. No historical result qualifies this tree.
Pop admission was closed with guard exit 78; PC/Mac were disabled. No child heavy
reservation/job, retry of an uncertain request, push or PR was performed.

Remaining production gates include parent composition above, independent review,
workspace tests and strict all-target Clippy, actual corrected SDK witnesses,
native/browser transaction qualification, full opening/layer/halfspace coverage,
appearance/provenance, final publication/consumer closure, generated artifacts,
determinism and end-to-end base/branch performance. No full P1/P2 or release claim
is made by this handoff.
