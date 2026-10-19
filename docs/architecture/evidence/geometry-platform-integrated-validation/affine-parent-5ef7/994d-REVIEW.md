# Affine source review round 2

Frozen commit `994d4dd7a399136f153cf6c5e0ea549e592b9c25`, base `e98406f5dffe4591e41b80d8fc841e29a1b056ab`. Scope: 29 changed Git objects in source-hashes.json, actual pinned SDK `c9c5979f04cea8c38213004d4f04df0dcfb40d05`, and the separately hashed unapplied managed-affine constructor hunk. Prior review `/tmp/ifclite-affine-review-51be` remains unchanged.

Verdict: **no new concrete source blocker identified in this review scope**. Prior unchecked-copy finding is repaired in source. This is not compilation, runtime, SDK geometry, browser, platform, performance, integration or production qualification. All new execution witnesses remain unrun. Future changes and the b20 independent-lease implementation are outside scope.

## Prior finding: repaired

The prior candidate called SmApiBrepCopy, whose SDK implementation constructs SmBrep and returns success, while SmBrep.cpp:673 calls `SE(MergeBrep(...))`; release SmMessages.h:627 defines `SE(a)` as `((void)(a))`.

New `native/smlib-adapter/src/copy.cpp` allocates an independent, context-owned empty BRep under an owner, preserves raw tolerance metadata and public editing/validate flags, then directly checks `MergeBrep(*source, nullptr, nullptr, FALSE)`. A failed status cannot become a handle. It additionally compares topology object counts. Composite/specialized faces and edges unsupported by this pinned copy path are refused before mutation. This helper is now used by the adapter's rigid17 and Boolean copy paths as well as affine18. No SDK source is changed.

The helper's derived-member pointer access reads/writes the actual base object's protected metadata without a base-to-derived object cast. It preserves raw DEFAULT sentinels rather than chasing them through SmTol getters. Source metadata is read only. A context guard restores all three raw context metadata fields on success, return and exception; its assignments do not allocate. This addresses empty SmBrep construction changing context tolerance metadata.

The deterministic UV trim Copy failure witness exercises an actual SDK MergeBrep early-return path through a derived rational trim class. It verifies terminal failure and rejection of unrelated live C ABI handles and session reset. A separate witness checks raw zone tolerance/context preservation and inherited DEFAULT behavior after a later context change. These assertions are meaningful source coverage, but have not executed.

## Failed-copy ownership and terminal status

Pinned MergeBrep can allocate topology before insertion; unique_ptr destruction alone cannot establish full cleanup. New copy failure handling deliberately abandons the partial copy, records module taint and returns status8 so isolation-boundary teardown reclaims process/Worker allocations. Affine conversion/transform failures after copying use the same terminal path. No retry/recovery or session reset can clear taint.

Every status-returning C ABI entry uses boundary(), which rejects before SDK access when tainted. ABI/capability/error-string queries are metadata-only exceptions. New native worker call() retires the captured process on kernel status8. The browser affine branch only retains the captured domain for synchronized statuses1–7; status8, unknown statuses and transport uncertainty retire it. Other driver command/release routes already retire on failure. The native/raw C ABI still requires its embedding caller to discard a tainted module; it does not autonomously exit.

Diagnostic construction can allocate. rethrow_tainted_kernel_domain sets taint first; if allocating its diagnostic throws, boundary's std::exception/catch-all fallback consults taint and still returns8. It therefore does not downgrade a copy-domain failure into a recoverable status5. The original requested operation does not publish a result.

## Optional prior hardening: repaired

factor() now checks the actual constructed first/last placement axes, including GetZAxis results, after SetCanonical. The composition is correctly last * signed-diagonal * first, reconstructing the supplied column-major linear matrix within the stated factor residual policy. Translation remains last. This is a numerical admission policy, not a certified surface-error bound.

## Lineage and chaining

Native/browser transform input enums admit only sealed Source, Result or Affine values, validate their actual leases/owners, retain immutable Arc lineage and exact caller matrix, and bound chained operation counts to128. Definition nodes retain immutable authored request and source/evaluation frames. Affine copies keep local baked coordinates; Boolean dependency admission requires an explicit proper-rigid world_from_affine and records a Placed node. Existing ordered Boolean lineage is retained when transforming a result. No manufactured public completion or raw-handle input grants this authority.

The supplied unapplied managed-affine hunk adds Arc<ManagedObjectLease> to the sealed native copy and acquires it immediately after decoding the returned handle. It is structurally consistent with the announced independent-lease ownership seam. It is intentionally absent from the frozen source; applying and validating it against b20 is still an integration requirement. This review does not attest the unseen dependency's implementation.

## Limits and remaining gates

Class whitelist/knot checks continue to exclude fitting branches and unsafe source representations. Those exclusions and the bounded matrix conditioning/scale envelope remain explicit preservation gaps for the broader objective. They are not resolved by this candidate or by box/cylinder witnesses.

Required next evidence includes compile/CTest with actual SDK, native/Rust affine chain tests, browser protocol and real Worker affine/lifetime/cancellation tests, common mapped-product integration and all authored source classes promised for production. Existing historical 4/4 CTests and21 regions belong to earlier source and do not qualify this extension. No builds, tests, PR comments or source edits were performed by this review.
