# Independent A1 core source review

Candidate `3e23a20bb88f451fa84dec9333063aaf5109617d`, base `067ef8327b7238a5eef106df722ad7e705c8ed18`, isolated checkout t3-abf98a0d. Reviewed immutable Git objects, including the candidate assembly/manifest. Exact blob and SHA256 identities for all 18 core paths and three documentation paths are in `ifclite-a1-3e23-source-review-hashes.json`.

No source edits, checkout/index changes, builds, tests, heavy jobs or publication. Historical integration passes and other reconstructed checkouts do not qualify this candidate. The supplied assembly is accurate that included tests and parser/metadata checks are not execution qualification.

## Verdict

No concrete blocking default-behavior, source-ownership or standalone dependency regression found in this slice. Core production APIs use core/standard-library types and existing dependencies; no geometry, processing, session, runtime, or construction-program production imports were introduced. The existing core geometry dev dependency is not new. This source verdict still requires actual candidate workspace tests/Clippy and downstream consumers, including PyO3/FFI/WASM, before landing.

## Execution ownership

ExecutionOwner defaults allocate no Arc; OnceLock initializes State only at explicit try_lease. Identity is allocated independently from addresses/IFC IDs. Existing EntityDecoder constructors share the original field initialization through Self::new and remain usable without any leases. Ordinary lazy decoding does not increment generation.

Root reservation uses an atomic exclusive CAS. Owned lease is Send and releases only the root reservation on Drop; child leases cannot release that root. Validation checks owner liveness, instance, generation and parent ancestry. Dropped/replaced instances and pending configuration/cache mutations reject. The new source APIs do not automatically block ordinary direct decoder calls: the executor must scope those calls under its reservation; the comments say this. Treating the lease as a universal lock around all public decoder methods would be an incorrect downstream assumption.

ExecutionWork validates before beginning, is thread-bound, and updates the captured generation only through explicit normal commit against the same live actual owner. Drop/unwind expires its lazy WorkEpoch without acknowledging mutations. Same-thread child capabilities remain tied to the active ancestor chain. Decoder source borrowing uses actual mutable decoder access plus an explicitly published active source epoch, not inference from a merely busy root. Only source edges bypass the thread check; generic child capabilities remain thread-bound and ordinary private try_lease remains exclusive. Source context holds only opaque resource data. No lock spans callback/source work. Expired source scopes can remain stored briefly but their epoch rejects until the scope restores its predecessor; this behavior is explicitly exercised.

SourceStopHandle is intentionally durable resource data: it can report recorded faults after work ends but cannot create an execution lease. Oldest ancestor has precedence; same-domain first fault is retained. It is not source authentication or proof of model authority. Downstream code must validate its own actual owner before installing resource context and must never treat commit or public opaque resource data as authority to accept an untrusted reply. These are usage obligations, not imports missing from this standalone slice.

## Decoder cache/generation preservation

Cache/index/unit configuration mutations notify execution ownership. Raw decoded/point/placement/grid imports revoke factory cache authority while leaving their historical trusted-input data behavior usable. Rejected typed transfers return before mutation/generation notification and preserve destination caches. Clearing/taking caches invalidates pending work but does not invent a new external-input revision; canonical recomputation remains possible. Public placement memo writes retain their existing documented canonical-transform precondition: SourceCache checks provenance of transfer, not correctness of custom transform code.

SourceCache moves bundle identity and trusted-input revision with opaque entries. Same-bundle canonical transfers remain authenticated; equal bytes in a different bundle do not suffice. Raw imports create fresh globally unique input revisions. TrustedDecoderInputs records explicit trust in the current revision without restoring SourceBundle::owns_decoder authentication. Borrowed None-source cache transfers retain the existing caller pairing precondition. That compatibility case should not be advertised as authenticated reuse.

Strict-real behavior is preserved: unrepresentable lossless records are not cached; typed transfer cannot make a strict decoder admit them. Ordinary cache setters and index installers do not silently clear cache/refusal state. Unit seeding changes the execution generation but does not itself prove physical correctness; it preserves the existing trusted caller unit contract.

## SourceBundle and source index

SourceBundle pairs one Arc byte allocation with a scanner-built index; factory decoders retain that allocation and index, without cloning source bytes or rescanning per decoder. bind_decoder only admits pristine decoders over the exact allocation. Existing raw index/cache imports cannot manufacture that authority. Compact-index delivery validates every canonical span and completeness using the actual scanner, including last occurrence for duplicate IDs. Equal IDs, equal length and equal span tables from another source do not import that source's inverse caches.

The adaptive compact builder preserves hash last-occurrence selection by sorting equal IDs by file offset, replacing earlier duplicate rows, and using the existing dense/columnar constructors. Its paged staging is bounded by the source-size estimate and converts to hash if duplicate-heavy row count exhausts that bound; wide native offsets stay hash. These are explicit source-index policies, not numerical geometry changes.

Factory grid inverse state belongs to the bundle rather than delivered index caches. Styled-item inverse state is bundle-local only for coherent columnar decoders; legacy shared columnar behavior and decoder-local hash/dense refusal domains remain intact. This avoids importing populated foreign inverse state when an otherwise valid span table is reused. Grid and styled source readers retain their existing scan/admission rules.

The sole existing decode_at behavioral branch is conditional on source_bundle. An earlier duplicate can be parsed/admitted without replacing the authenticated canonical ID cache. Legacy EntityDecoder::new/with_index/with_arc_index callers retain cache-first duplicate behavior; SourceBundle::install_compatibility_index installs under that old contract and does not authenticate the decoder. This slice does not migrate the existing main consumers to SourceBundle, so it does not impose factory last-wins semantics on their prepass caches.

## Nonblocking documentation/test refinement

`docs/guide/parsing.md:486–488` broadly says direct reads of earlier duplicates remain readable. The implemented guarantee is specifically decode_at. The unchanged `decode_at_with_id` fast path still returns an already cached entity before considering the passed span. For example, warm canonical #1=IfcBeam, then call decode_at_with_id(1, earlier IfcWall span): it returns Beam, while decode_at(earlier span) returns Wall. This preserves the old fast-path API contract and does not poison canonical caches, so it is not a default semantic regression. Narrow the new prose to name decode_at, or explicitly document this distinction; do not change the compatibility fast path just to simplify prose. A real duplicate fixture exercising both warm/cold order and both public APIs would make this boundary clear.

Existing tests are predominantly meaningful ownership/admission invariants: actual decoder reads after error/panic and across scoped threads, same-instance mutation commit versus replacement/unwind, original source bytes and canonical spans, foreign inverse cache poisoning, populated destination preservation, strict overflow refusal and duplicate-cache admission. Ownership-state assertions are appropriate for an ownership API; they do not merely test a mock return. The compact-builder tests use private constructed rows to assert the storage/span invariant and a real scanner/hash oracle for canonical selection.

The point/placement transfer test seeds a placement memo and reads it back, but this verifies opaque provenance transfer and foreign-destination rejection, not geometry-transform correctness; its comments correctly delimit that trusted memo-writer contract. Do not cite it as proof of placement math. The retained-source feature/geometry-family plan is outside this independent core PR slice and is not a reason to add further architecture here.

## Required candidate qualification

Run actual candidate cargo test --workspace and warning-strict Clippy, core-sensitive module/function/refwalk gates, API examples and ordinary downstream builds. Recheck exclusion crates (PyO3 and C FFI with correct unwind profile), wasm compilation/generated types if any public binding projection changes, and base-versus-candidate end-to-end performance/output identity. In particular, generation atomic bookkeeping and new decoder fields are not free merely because no Arc allocates on a warmed legacy constructor. None of these results is asserted by this read-only review.
