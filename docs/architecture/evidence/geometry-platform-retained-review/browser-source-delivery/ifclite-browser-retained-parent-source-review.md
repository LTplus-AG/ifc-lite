# Browser retained source review

Primary immutable checkpoint: `4168d78f31e50b7cfdf9df7aaca70e9cd29ce816`, inspected through Git blobs in `/home/louistrue/.t3/worktrees/ifc-lite/t3-c77756ad`. The checkout itself was already later. The separate authority addendum below reviews only the changes through `1550026c778e42680c72928e552bdca9326dfea4` and their called document ownership check. Inspected blob identities and SHA-256 hashes are in `/tmp/ifclite-browser-retained-parent-source-review-hashes.json`.

This is static source review. I ran no build, browser test, worker job, numerical qualification, or heavy command. Existing test source was inspected; its presence is not an execution receipt.

## Concrete findings at 4168

### Public in-flight cancellation is inaccessible through the borrowed executor

`rust/wasm-bindings/src/api/retained_browser.rs:53-77` exports an async `RetainedBrowserSource::execute(&mut self, executor: &mut RetainedBrowserExecutor, ...)` and retains that mutable executor borrow across the Worker await. `RetainedBrowserExecutor::retire(&self)` is exported on the same object at lines 36-38. With wasm-bindgen's checked exported-object borrows, JavaScript cannot call that method (or free the executor) while the async mutable borrow is outstanding. Merely abandoning a JavaScript Promise does not drop the underlying Rust future.

Consequently, the Rust `InFlight` drop guard is a useful cleanup primitive but does not itself provide a usable JavaScript cancellation entry during execution. `browser_bridge_tests.rs` explicitly polls and drops a Rust future; that is a different reachable operation. The host contract test retires the executor after awaiting execution, so it does not distinguish this gap. This finding also applies to 155, whose execute signature and await ownership are unchanged.

A minimal distinguishing host test starts an actual exported source execution, calls the cancellation entry before awaiting its Promise, and verifies that no recursive/borrowed-object exception prevents retirement. It must then verify Promise rejection, absence of publication, and replacement-worker success. A Rust-only future drop test cannot replace this assertion.

### Publication receiver receives retirement authority too early

At 4168, `ModelBoundRetainedDocument::validate_browser_publication` checks the receiver's lifecycle first, retiring the supplied publication's captured realization on receiver expiry, and only afterwards checks the publication's definition against the receiver document. A stale foreign receiver can therefore retire another document's worker. `PublishedBrowserSource` also exposes all fields publicly, permitting host Rust code to recombine a work receipt with different handles. This is a real library boundary problem even though the WASM wrapper does not export a raw publication constructor.

This finding is statically closed by the 155 addendum below.

## Source and completion boundaries verified

The source-only admission path uses the existing installed coherent load, rather than accepting a second source or a caller-created completion. `IfcAPI::retained_bound_plan` requires `coherent_source`, snapshots that load's `ProductionModel`, and constructs the decoder from the same `SourceBundle`, with strict real admission. `admitRetainedSource` compares the supplied JSON value to a complete serialized key from the actual reached definition list, then passes the selected canonical key into `admit_source`. Changed or extra key fields do not grant authority. Key listing can include unsupported definitions; listing is not execution qualification.

The called `SourceBundle::with_columnar_index` validates the installed index against canonical source spans. `SourceBundle::owns_decoder` requires the private bundle identity and unchanged cache provenance; bound context admission checks this, lifecycle, and actual decoder execution identity. The bound plan cache is keyed by decoder identity rather than a single context-wide first-plan slot, and retains weak entries. It does not silently reuse another decoder's first warmed plan.

I specifically inspected the authenticated decoder's `decode_at` implementation: a noncanonical duplicate record span can be decoded, but is returned without memoizing it into the authenticated ID cache. Thus the earlier hypothetical first-duplicate prewarm poisoning argument does not describe this actual source version. No such defect is asserted here.

Source replacement through the installed-byte/index/reset APIs invalidates the coherent model lifecycle. Issuance, post-await completion, acceptance, and display validate the source lifecycle at their respective reached boundaries. The owned document keeps a small lifecycle token; its numerical ready/receipt objects do not need to retain an entire raw source allocation. A model snapshot surviving ordinary owner drop is an intentional owned-snapshot contract, distinct from explicit source invalidation.

Issued and completed browser work have private tickets and payload fields. Exact Arc ticket identity is checked before a receiving document acquires retirement authority in `accept_browser`; a wrong receiver gets the original work back. Correct-receiver source expiry retires the captured runtime. A failed execute drops its issued ticket; post-response rejection drops the captured realization. Successful publication clears the pending slot once. Runtime completion contains the actual owner/object lease, not a caller-supplied numeric worker ID or public typed-array completion.

The runtime arms its `InFlight` guard before await, validates the same owner afterwards, and copies the driver response into Rust-owned data before common completion validation. Driver private object leases are invalidated on captured-worker retirement. Common borrowed publication validates document/revision/source handles and the retained mesh contract before adding the mesh and occurrences. The display API serializes copied output; mutating returned JavaScript positions or occurrence arrays does not replace Rust's sealed publication or receipt. This is not an exposed raw WASM memory view.

No other concrete source-binding or ticket acceptance blocker was found in these inspected paths. This is not an exhaustive claim about the separate numerical implementation or all browser transport behavior.

## Separate 155 authority addendum

I inspected immutable `1550026c778e42680c72928e552bdca9326dfea4`. Relative to 4168 it changes only `bound_browser.rs` and the WASM publication getters.

`PublishedBrowserSource` fields are private, with read-only getters. More importantly, `validate_browser_publication` now calls `self.document.document().mesh(publication.definition)?` before lifecycle-triggered retirement. The called `GeometryDocument::mesh` uses `definition`, which first checks exact `DocumentId`, then slot existence and generation. A foreign receiver therefore returns `WrongDocument` without retiring the supplied worker. Public handle recombination no longer constructs a publication. This closes the identified authority inversion in static inspection. A real behavioral regression should retain a publication from live document A, expire unrelated document B, validate A's publication through B, and then prove A's object still validates and displays; field privacy alone is not that behavioral witness.

This addendum does not qualify later parent cancellation changes or any uninspected checkpoint.

## Independent cancellation capability

The proposed opaque cancellation capability is a coherent repair while retaining the serialized mutable numerical API. It should hold only the exact captured shared runtime owner and expose synchronous explicit retirement; it must not borrow `RetainedBrowserExecutor`, expose transport internals, accept numeric owner IDs, or grant a second evaluator. Acquire it before starting the async exported execution. Its explicit retirement must invalidate object leases and terminate that captured worker even while the executor wrapper is mutably borrowed.

Clones must all target the same captured incarnation, and repeated cancellation must be idempotent. An old capability must never discover and retire a replacement worker. Passive capability destruction should merely release its reference, unless an explicitly documented cancel-on-drop policy is intended; dropping an incidental clone must not unexpectedly cancel execution. Normal executor destruction can retain its existing retirement semantics. This does not require making `evaluate` generally reentrant or weakening the actual driver busy/serialization checks.

Required actual-browser invariant: obtain a capability, initialize the actual worker, start exported execution without awaiting, synchronously retire through the capability during the pending Promise, observe no borrow exception, await a typed failure, and verify no source publication is returned. Assert that the old object's liveness is false, and that a newly allocated executor/source can produce the known nonempty volume and occurrences; cancelling the old capability again must leave the replacement live. Also cover cancellation before worker startup finishes and cancellation after actual command dispatch using a deterministic real transport event/barrier, rather than a geometry mock or timing sleep. Every handle must be freed in finally paths. Ticket cleanup should allow the documented subsequent request policy without stale acceptance or duplicate publication.

## Coverage limit

This API explicitly publishes `unstyled_flat_source_only` mesh/occurrence output. It does not issue or accept retained work through the canonical inner ProductProgram request protocol, replace product geometry production, or establish coverage of enclosing booleans, openings, appearance, source dependencies, and complete product assembly. Those remain integration work, not a defect concealed by a source-only receipt. Numerical-route qualification also does not establish all-source or full IFC/browser qualification. The existing tests and this review must be described at that narrower scope.
