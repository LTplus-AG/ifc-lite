# Common retained construction: independent program review

Reviewed immutable source `22bb418a02` against `53dafdcf7f` in `/home/louistrue/.t3/worktrees/ifc-lite/t3-1ce7f62c`. All 26 changed files and three supporting files match the requested commit. Exact immutable hashes are in `/tmp/ifclite-common-construction-parent-program-review-hashes.json`.

**One concrete preservation blocker: retained root alignment prelude still invokes ordinary mesh callbacks.** No source edits, builds, tests, jobs, network requests or child agents were performed. All twelve behavioral fixtures remain UNRUN; seven SDK-dependent fixtures may skip without the configured real worker. Parse/guard metadata is not type or geometry qualification.

## Blocker: unsupported retained root can run opaque mesh execution

`program/retained.rs:82–89` builds retained entry from ordinary `GeometryProgram::parts`. Its merged product prelude is already initialized. `inner_product_prelude.rs:61–64` arms AlignmentLower when that root is IfcAlignment. `inner_product_adapter.rs:161` dispatches Action::Prelude through the ordinary `action.execute` without a retained-mode guard.

That ordinary implementation invokes the actual selected processor's `lower_owned` at `inner_product_prelude.rs:135–143`. If it returns None (the supported extension contract), acceptance schedules AlignmentExtension. On the next Extension request, `inner_product_prelude.rs:146–150` invokes actual `processor.process`, which can return sampled geometry and mutate decoder/cache/report state. Only the following Numerical request is rejected by retained `ReadyOperation::admit_retained`, because Prelude numerical work is not an allowed retained payload. The built-in-only guard in `ItemSource::execute_retained` is never reached by this dedicated root branch.

This does not fabricate a successfully authored receipt or final output: retained numerical admission eventually refuses. It nevertheless violates refusal-before-opaque-exact-work for an unsupported retained entry and can perform unexpected extension/source effects before refusal. It is a concrete reachable source path, independent of absent SDK qualification. A registered IfcAlignment processor with default lower_owned(None) and a counting/mutating actual process callback is enough to observe it. A nonempty returned mesh reaches the later retained refusal; an ordinary callback error/empty outcome may also resume ordinary representation traversal.

Proposed narrow correction: in the retained ProductRootAdapter, explicitly reject a reached alignment Prelude action before calling its ordinary executor. Do not silently disable the prelude and fall through to body geometry: that would change which alignment contract is being evaluated. Keep the ordinary branch when `retained == None` unchanged. Add a real custom alignment fixture requiring both lower_owned and process callback counts remain zero under retained entry, while the existing exact alignment fixture still invokes its actual callback and preserves decoder mutation/late placement behavior. No SDK worker is required for that refusal test.

## Concrete implemented consumption path

For supported ordinary analytic leaves, the implementation is substantive common control consumption rather than an inventory replay:

- ProductState keeps its original pending geometry attempt. The common product machine and ProductProgram admit selected representations and complete Items lists at their existing reached points.
- Retained mode selects a logical ItemValue rather than injecting a finished Mesh. A reached builtin leaf captures original extrusion/swept-disk data, units and source evidence. Unsupported leaf families/custom registered item processors refuse, with no exact leaf retry.
- A separate child GeometryProgram identity supplies each logical slot; occurrence is not the source STEP ID or authored-record ordinal. Repeated source IDs produce distinct slots and ordered entries. The owning ProductControl consumes the same original nested reply and then advances its existing representation iterator.
- IssuedCommonConstruction owns the immutable request, lifecycle/cancellation capability and ticket/stage handles, without decoder/router/borrowed TLS. Native work evaluates only that request. The same original common reply stays pending in processing, rather than accepting a caller-created mesh.
- Completion returns only an inspection plan with explicit placement/opening/layer/appearance/persistent-face requirements. The wrapper exposes no final mesh publication method and ProductState::finish asserts retained mode cannot enter ordinary mesh assembly.

The primary TexturedSubmeshes attempt is deliberately represented by the merged retained traversal instead of exact styled/layer evaluation; this is incomplete construction capture, not presentation equivalence. Known texture source capture refuses and remaining requirements stay nonempty. Common mapped DAG/occurrence, Boolean/opening and browser transaction cases remain excluded rather than implemented by this checkpoint.

## Sealed native receipt and pre-consumption checks

The pending transaction stores original outer/common requests, nested engine reply, actual context ID and owner stamp, source operation, document request and cancellation owner. `validate_intact` checks ticket Arc identity, exact stage, source/context/decoder identity, original request/owner, ordinary ProductState reply validation, exact RetainedRequest admission (including recipe Arc identity), live runtime object, document validation and independently expected f64 frames before any reply take. Ledger slot reuse is rejected.

Resource validation and ledger capacity precede the DELIVERED-to-ACCEPTING transition and consuming accept. Failed ordinary acceptance restores the intact original reply and delivery stage when cancellation has not won. Cancellation may invalidate the runtime after admission, but that cannot mint a final certificate: later traversal discharge checks require all sealed ledger objects live, and the plan still lists remaining final requirements. Foreign ticket validation precedes own-source retirement, protecting unrelated workers. Actual root authentication re-decodes the reserved source root and constructs the canonical job from it, ignoring caller-edited root attributes.

These are source-level ownership observations, not an executed race or acceptance proof. Deferred browser acceptance, common operand-slot identity and final-net closure remain required before complete retained execution can be claimed.

## Exact/default and qualification boundary

Default ProductState has `retained_contract=None` and continues the same exact execution branch. The ItemResult enum plumbing maps exact meshes through ItemValue::Mesh, preserving exact numerical builders and source callbacks. No changed exact arithmetic, unit scaling or mesh builder was identified in this delta. This static review cannot prove all enum match arms/type paths compile, that resource/error-order behavior is identical under every branch, or that any native SDK test passes.

Before qualification, fix the retained alignment-prelude hole, compile all targets/tests and Clippy, execute the twelve behavioral fixtures with actual worker availability explicitly recorded, and run exact/default preservation and available real consumer geometry comparisons. No full-platform, scene, heap/RSS, speed, final-net or public retained cutover claim follows from this checkpoint.
