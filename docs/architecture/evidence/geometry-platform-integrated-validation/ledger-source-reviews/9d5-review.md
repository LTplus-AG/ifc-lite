<!-- SPDX-License-Identifier: MPL-2.0 -->
# Independent source review: bounded face lineage 9d5dc61e56

Reviewed exact commit 9d5dc61e56 incrementally against 2915e1a3c4c4544f5da64044b2b06e45501ba667. Read-only review; no builds, SDK execution, numerical qualification, or paired-split closure. Changed-source SHA256s are in `/tmp/ifclite-ledger-9d5-review.json`.

## P2: continuously observed newly constructed faces cannot receive their first explicit root

`src/face_lineage_events.cpp:81–86` creates a Binding and an incomplete Construct node for every actual face constructor observed by the outer Scope. `src/face_lineage.cpp:106` then rejects **any** existing binding during `admit_roots`, including this first constructor-only binding. Consequently, a freshly built generated cutter/interface or independently issued source constructed while continuous observation is active cannot ever receive its first SourceBoundary/GeneratedInterface/DerivedAuxiliary root. Its complete actual face inventory and issued operation/revision do not help. Detaching/reopening is deliberately prohibited, so it cannot be used as a safe workaround.

This contradicts the contract's first-issuance allowance for freshly constructed derived geometry and prevents the ledger from supporting generated interfaces produced later within the same continuously observed operation lifetime. Current mixed-origin fixtures construct both rooted plane patches before installing the outer Scope, so they do not exercise this case.

Repair with an explicit, narrowly authenticated initial-issuance transition for a currently live constructor-only face in an audited construction phase (including bounded resource preflight), while continuing to reject copied/split/merged/edited/retired or otherwise unknown history. Alternatively, formally restrict this increment to preexisting initial roots and keep later generated-root issuance as an explicit blocker; it must not be treated as supporting that operation yet. Add an actual SDK witness constructing a fresh generated patch under the active outer Scope and admitting its first root, plus refusals for a prior copied/retired binding.

## Other reviewed properties

No additional concrete blocker identified in the scoped implementation. Immutable parent DAG traversal is iterative and roots are deduplicated by node visitation. Constructor/destructor generations, continuous-scope closure invalidation, protected-source copy phases, callback chaining/restoration and failure latching, fixed storage limits, map/inventory checks, and post-mutation status8 path are present in source. Runtime object authority/sealing and checked paired intersection/extraction remain explicitly outside this increment.

Actual SDK witnesses remain UNRUN. Syntax-only reports do not establish that the SDK emits all assumed notifications, that split/merge fixtures reach their assertions, or that the public runtime can publish a certified result.
