<!-- SPDX-License-Identifier: MPL-2.0 -->
# ProductProgram representation and constructor phase

This incremental implementation starts from the restored 288-file source
manifest with SHA-256
`ede5cfafab73e79657c4680398156b84cc4ce62f6fd4fb50a4ef4dba2e16207b`,
plus the parent qualification fixes (five streaming events, original batch API
descriptions and obsolete positional-read allowance removal). It incorporates
the recovered constructor work and extends its representation/item coverage.
It does not qualify the whole geometry platform or replace processing's attempt
and snapshot authority.

`geometry/program/traversal.rs` owns five explicit entry policies:
`MergedProduct`, `StyledProduct`, `TypeMap`, `OpeningItemMeshes` and
`OpeningItemBounds`. Whole representation admission precedes selection and
whole selected Items admission precedes the first item. Skipped descendants
are not decoded. The ordinary product item execution lives in `product.rs`;
the public router entrypoints drive it synchronously and retain their original
alignment/layer entry gates, hygiene and final placement. The replaced loops
are deleted.

Opening admission preserves the probes' distinct error strings and permissive
shape handling. Whole representations resolve before placement, and placement
before each selected Items list. Missing or bad lists and failed items skip
only their original scopes; placement failure means identity. Mesh probes try
the raw-per-element route first. Bounds probes admit direction before geometry,
bypass that raw route, and evaluate the original corner arithmetic per frame
in `opening_bounds.rs`. A zero direction loses only that item's direction.
Opening classification, rectangle/profile capture and application orchestration
remain in their existing owners.

`program/mapping/` owns the two existing mapping frame machines, path sets,
ordered child occurrences and owned occurrence admissions. The replaced mapping
frame machines are deleted from the router. Narrow router services retain cache
ownership and reached effects; the existing flat orphan-cache materialization
helper remains synchronous at its original reached point. Merged mapping resolves transforms before cache lookup,
admits required whole Items before claiming the source, releases failed path
IDs and propagates truncation. Styled mapping resolves representation before
transform, claims before optional Items, preserves sticky failed IDs and applies
transforms only to each successfully appended range. Template selection, UV and
instance order and shared-cache publication policy retain their existing rules.
These are synchronous child programs, not opaque source-free Execute commands.

`program/type_map.rs` uses the same item cursor without filtering non-Body maps.
Only counting is suppressed. Each textured item stays separate; untextured
items merge by frame. Nested maps keep the merged consumer's existing lack of
UV output. MappingOrigin is admitted after every item; a resolved wrong
placement type means identity, while a failed reference propagates at that late
point. Ordinary mapped occurrences retain stricter earlier origin validation.

The nineteen built-in constructor admissions return the common opaque
`program::OwnedConstructor`. Canonical dispatch calls `lower_owned` on the
actual selected processor. Optional ConstructionBatch roots use the same
selected-instance hook and payload; operand roles keep their existing fresh
builtin dispatch. Its eager graph does not replace canonical boolean control.
The numerical constructor evaluator has no decoder or router. Empty operand
flags, boolean continuation and exact-kernel recovery remain unchanged.

Annotation fills now admit validated style and owned rings before numerical
triangulation/scaling/storage checks. Texture attempts admit the existing owned
triangulated payload and use `evaluate_with_texture` against the selected
immutable texture input; failed attempts still recover through plain geometry.
No per-product texture-index clone is introduced.

Custom registrations retain actual mutable-decoder process/RTC callbacks when
they decline owned lowering. No program frame stores a decoder, borrowed scope,
transaction, kernel budget guard, unsupported-counting guard or triangle-order
guard. Owned counting policies are installed only around synchronous reached
work. Public borrowed Rust entrypoints and existing JavaScript batch/raw ABI are
unchanged by this layer.

Remaining work includes boolean/CSG program migration, layer eligibility and
slicing, opening classification/capture orchestration, full terminal resource
admission, effect receipts and finer request/reply identities. Processing still
drives its existing outer ProductState work synchronously. Source lifecycle
labels do not authenticate bytes/index coherence; the separate source-bundle
work must be integrated and qualified independently. No public asynchronous
scheduler, complete resource envelope, active SMLib cutover or performance
improvement is claimed.
