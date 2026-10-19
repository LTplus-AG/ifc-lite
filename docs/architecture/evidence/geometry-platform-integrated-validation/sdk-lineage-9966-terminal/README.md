<!-- SPDX-License-Identifier: MPL-2.0 -->
# Native lineage repair qualification

Pop!_OS job `4db1e1d3-9c75-4919-8fd6-d879d6206cb6` ran the full eight-test native adapter qualifier on source `9966214961c3988391ce175c54782c4592485e9f`, with pinned SDK `c9c5979f04cea8c38213004d4f04df0dcfb40d05`. Source remained unchanged. Seven tests passed; `smlib_owned_boundary` failed, so aggregate exit was 8.

`smlib_paired_copy_observability` now passes, including actual split/merge, precise UV refusal, target-switch and frame refusal, actual target/face address reuse, callback limits and foreign callback invariants. Exact transition fixtures construct independently checked unit-parameter edge and UV lines before root issuance; unmodified SDK box copy controls remain separate. Constructor receipts are selected by actual caller type across the operation, rather than notification order. Allocation-only fixture constructors preserve the allocator-written context under C++ value initialization.

This establishes the copy/lineage prerequisite only. It does not qualify paired geometry, production ownership enrollment, WASM, browser, performance or the full platform. The remaining native failure is analytic-to-rational affine conversion of an actual clipped box: UV control `(-4.4408920985006262e-16, 2)` lies outside the supported plane map. No epsilon waiver or fallback was introduced.

The repair source remains on `repair/sdk-qualified-failures-f778`; it is not yet integrated into the root migration branch. Original worker receipt and compressed output are retained verbatim.
