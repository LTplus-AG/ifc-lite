# Shared walk entry and placed-clip source review

Frozen shared-walk change `8828c18285` against `56a64ed499`; separate additive placed-clip change `5468eeba295865647ccc2b3ad872ba81524c7902`. Read-only immutable source review. No source edits, builds, tests, executable probes or jobs. No new concrete source blocker identified in either scoped change. Actual full workspace/native/browser qualification remains parent-owned.

## Shared budget entry

`RetainedWalk::scope` now distinguishes shared domain by Arc::ptr_eq on the actual Budget allocation. CURRENT absent or a different budget still charges entry; same-budget nested wrappers check the sticky captured terminal without another envelope charge. Both cases then reinstall this controller's own immutable ancestry and use the same restoring guard. The comparison does not infer authority from source IDs, path equality, numerical counters or a caller-supplied flag. No mutable RefCell borrow is kept over check/charge or downstream work.

This removes recursive wrapper multiplicity for the same request, not child or output work. RetainedWalk::child still debits the parent, checks path membership and mixed depth, and constructs a separate immutable occurrence path sharing the monotonic budget. Captured copies, slots, retained history, presentation, cached-entry scans and incoming-value/claim expansion retain explicit shared debits. WORK_LIMIT remains MAX_OPERAND_VISITS1024 * MAX_MAPPED_ITEM_DEPTH32 =32768; no production/default or smaller fixture limit is raised. Finishing still checks the original root terminal, so a caller cannot convert a refused poll into partial success.

I inspected the affected envelope call sites (request, execute_with_inputs and numerical admit_retained_with_inputs), retained child entry constructors, controller request reducers and Boolean path machinery. The request reducer consumes completed owned controller/child state or yields an actual request. Cache completion reduces one Child to Local/Complete; Product adapter polls finite prelude/child/state and yields an action. Boolean request reduction pops owned frames, reduces bookkeeping, or yields source/numerical work; source-driven Boolean entry retains OperandPath visit/path/depth guards. In particular, the removed envelope debit was not a per-frame guard inside those loops. No new indefinitely repeatable file-following loop was found that depended only on recursive same-budget envelope charges.

Cycles still hit actual path child admission or the existing Boolean OperandPath; a same-id sibling remains a distinct accumulated occurrence because membership is occurrence/path-scoped, not a global dedup set. Cached DAG expansion still charges value/claim/copy lengths and cache scans, rather than being free because its wrapper is cached. Existing mixed mapping/Boolean cycle, acyclic-depth and diamond multiplicity/fanout fixtures remain relevant and must run against the assembled source.

A different root always has a different Budget Arc, even with equal IDs. Foreign reentry is charged and its TLS ancestry is restored on unwind. CURRENT is thread-local: first entry on another thread has no same-domain ambient exemption and charges; the shared Arc/Mutex carries spent/terminal state. Private guards remain lexical in the inspected synchronous controller call sites. This change introduces no scope across asynchronous suspension or source-service lifetime.

The three new invariants directly check nested own-path reinstatement without duplicate envelope work, real child/effect debit and sticky terminal, different-budget charging plus panic restoration, later external reentry debit, and ancestor-cycle refusal. They are small internal budget invariants; they do not replace actual source-graph tests. No executed82.5% trace or performance result was independently reproduced here.

The pre-existing mixed-controller depth32 preservation gap remains: stopping safely does not prove that all formerly valid combinations admitted by separate historical domain limits are preserved. This patch neither closes nor worsens that gap by changing caps; bounded iterative control and corpus-boundary proof remain separate work.

## Absolute placed clips

Native and browser add PlacedClip to their existing sealed dependency selector. Both validate the original clip lease, select its unchanged solid/token and retain original clip lineage/history, then install the supplied replacement evaluation-to-world frame directly. The native branch validates proper-rigid before returning; browser validates through the existing common final rigid(input.frame) check. It does not multiply by the prior world frame, transform plane coefficients, bake another SDK copy, mutate the original receipt or create a second traversal.

The Placed lineage node wraps the original PlaneClip history and records the exact replacement frame; operation count stays the original count because selection itself is placement, not a new numerical operation. The eventual clip/Boolean operation retains its existing debit and identity validation. Clipping's normal foreign-owner checks, cancellation, lease guards and limits remain shared.

New native and actual-Worker test source checks local volume, replacement frame, unchanged original frame/input identity, nested Placed→PlaneClip lineage, invalid nonuniform/reflected/NaN frame refusal without invalidating existing outputs, and surviving derived output after source drops. These are meaningful candidate witnesses but are unexecuted here; native SDK and actual browser results must be supplied by their normal qualified runs. The additive worker_dependencies hunk does not replace unrelated parent Boolean temporary-cleanup logic during assembly.

## Exact source pins

Full commit IDs, Git blobs and SHA256 for14 walk/controller paths and four placement paths are recorded in `/tmp/ifclite-8828-walk-and-5468-placement-review-hashes.json`.
