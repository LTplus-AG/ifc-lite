# Layer child implementation review

Read-only inspection of the active dirty root implementation. No builds, tests, profiler runs, source edits, or fleet jobs were started. This does not qualify these changes using the earlier immutable validation receipt. Exact inspected file hashes are in `/tmp/ifclite-layer-program-review-hashes.json`; the comparison source is `/tmp/ifclite-layers-before.rs`.

## Result

No concrete geometry, error-order, callback-order, or source-admission regression identified in this extraction. Compilation and runtime success remain unverified by this review. The earlier possible gateway intra-doc-link concern was already resolved in the last inspected source (`crate::SubMesh` qualified link).

## Preserved behavior found in actual code

- The public borrowed method signature and gateway callers remain intact. The gateway still performs the index lookup, `is_sliceable` gate, fallback/error diagnostic, fewer-than-two fallback, and slab hygiene in the original order.
- `LayerProgram::admit` preserves the original sequence: sliceability, layer count, source eligibility, thin-layer merge, collapsed-layer refusal. It does not resolve placement early or execute geometry for an ineligible element.
- Eligibility still uses `product_shape` and only the first `Select::Body` representation. It requires one item and descends only `FirstOperand` through Boolean results with the same iterative visited set. Whitelisted leaf types, implicit missing/null identity placement, and matrix tolerance comparisons are unchanged. Generated slot `.index()` substitutions are numerically 3 and 1, respectively, and retain the permissive `.get`/`.get_ref` behavior; they add no typed-owner assertion on malformed data.
- Actual `process_element_with_voids` runs after eligibility/merge and before frame admission. Its error propagates before any final layer diagnostic; an empty host records the same skip and prevents placement lookup. The continuation stores the actual returned host, not a reconstructed substitute.
- Late frame admission still resolves placement through the router, scales translation, then obtains unit scale and RTC. Those getters return existing fields directly. All plane arithmetic and evaluation order match the old body: normal from rotation then normalize then direction sense; offset scaling; cumulative thickness including the final loop increment; direction-weighted distance; world transform; subtract RTC and actual host origin in that order. No extra narrowing or source reads were introduced in numerical evaluation.
- The progressive carve retains the original mesh clone, two clips in tuple evaluation order, uncapped clipping, remainder replacement, degenerate-interface recovery, origin restoration, material IDs, and empty-slab omission. Both failure-to-fallback and fewer-than-two diagnostics remain at their reached original boundaries.
- Thin merging retains the 2 mm threshold, strictly smaller victim selection, first-victim tie behavior, previous-neighbor preference for equal neighbor thicknesses, dominant neighbor material, and source layer thickness/unit conversion.

## Ownership and performance scope

The new continuation owns visual layers, the actual host, and then planes. Decoder, router, temporary source entities, and lexical guards are not stored. No additional geometry clone, coordinate conversion, collection scan, or source traversal was found: the old remainder clone and plane/visual-layer vectors remain. Fixed-size placement/state moves replace stack-local fields. This is a source review, not an allocation or end-to-end performance verdict.

The state types and methods are private and synchronously driven. This is a genuine owned source/numerical seam, but it does not yet expose a scheduler request/reply boundary for the common program. It does not independently implement cancellation, resource reservation, source authentication, or asynchronous callback execution. Those are separate work, not regressions in the preserved borrowed driver.

## Actual test scope and remaining qualification

The two new public-router geometry tests encode independent shell-area (28.2 m²), material ordering, layer-band, and no-interface-cap invariants. The mm/quarter-turn/5 Mm case exercises large source coordinates with RTC equal to the supplied element translation. Existing iterative-cycle and thin-merge invariants have moved to sibling modules. I did not execute them.

Before stronger preservation claims, useful targeted invariants are:

1. A selected custom actual processor mutates decoder placement/cache during host production. Assert that the final planes use the reached post-callback placement, and assert callback/report chronology. The code currently preserves that order; the new tests do not pin it.
2. A genuine opening-cut layered host: assert exterior shell area including the opening reveal, no internal interface caps, material order and opening diagnostics. The two new boxes use an empty void index.
3. A case whose actual host has a nonzero mesh origin independent of RTC, plus negative direction sense/other axis. Current frame code retains subtraction, but the survey case may allow the local origin component to be zero after exact translation RTC; it cannot establish all frame combinations alone.
4. An Axis representation before Body, and multiple qualifying Body representations. Assert the original first-Body eligibility policy and callback count, rather than broadening selection under the extraction.
5. Empty/error host should prove placement lookup is unreached; ineligible/multi-item/thin-collapsed source should prove host callback is unreached. These are sequencing tests, not merely final skip-string checks.

All are qualification gaps rather than observed failures. Public-router tests alone do not claim canonical processing presentation, full native orchestration, complete scene identity, or exporter coverage.
