# Created-zone native fixture correction review

Candidate `8b6b71e0a468a6503b98d808d3db3ca9c7a1a773` versus `3b309fdcaf2e8aa8e034a7ea1605016980fd8ac0`; SDK primary source pin `c9c5979f04cea8c38213004d4f04df0dcfb40d05`. Read-only immutable Git source, original compressed job output and SHA checks only. No source edits, compilation, tests, SDK execution or job submission.

## Verdict

No concrete source blocker found. This is a legitimate fixture-consistency correction, not a weakening of production validation or a demonstrated numerical repair. Next native execution remains UNRUN. The previous actual run remains four passing CTests and one failing owned-boundary CTest; it cannot be relabelled passing.

## Actual failure and SDK predicates

Original output lines374–393 enters explicit_context=0/source_defaults=0, completes the unchecked copy observation, then fails at `copied host before Boolean`, before cutter/Boolean evaluation. It reports26 pointer failures at BRepTol0.0002. The six visible test6 reports do not contain measured face tolerances: pinned `SmAssertArray.h:897–907` passes SM_UNDEF_DOUBLE for both scalar fields in the BOOLEAN_REPORT macro. The printed1.23456e-61 values are therefore sentinel fields, not evidence of tiny face geometry.

Pinned `SmBrep.cpp:31274` test6 is precisely face.GetTolerance()>0.99*BRepTol; `31507` test60 is the corresponding edge lower bound with actual value/tolerance report fields. The log's edge1e-5 versus required0.000198 establishes a genuine inconsistent BRep/topology zone setup. `31645` test83 is the analogous vertex predicate, but capped logs do not prove it was one of the unprinted failures. Both lower and upper SDK tolerance predicates remain unchanged.

## Correction and preserved oracle

The only changed source is context_metadata_tests.cpp,12 additions/5 removals. It no longer overwrites context.zone or source.zone after creating boxes. Source raw size/ratio still cover explicit versus DEFAULT, context raw size/ratio still cover explicit versus DEFAULT, and sibling starts from its own actual metadata before varying only its size/ratio. Access::set writes the retained zone value back bit-identically; it does not recompute or propagate a new zone through faces/edges/vertices. SDK-created topology zone fields are not edited by this patch. The original raw-sentinel empty-copy-only case remains separate and invokes no positive geometry oracle.

The existing ObservingTrim still delegates a genuine SDK curve copy and verifies expected shared context plus raw/effective context/source/sibling metadata DURING MergeBrep, not just after return. Existing state checks, real successful volume6, semantically Empty outcome, unsupported Union and usable-domain assertion remain intact. New validate_plane_solid(copy.get(),...) runs only on the owned copy, before clipping. That production validator still requires actual ValidatePointers status plus zero reports, bounded void infinite region, closed manifold/nonempty faces, closed geometric trim loops and positive finite volume. It adds a stricter earlier gate; no report, supported class, tolerance or numeric volume threshold was removed.

The observer proves the raw/effective metadata fields it actually snapshots; it is not a new byte-for-byte witness of every topology tolerance throughout arbitrary SDK operations. Static patch inspection establishes that fixture setup now leaves those created zone fields alone. Qualification must still establish actual checked-copy/cutter/result validity and numerical outcomes on the pinned SDK. A failure later in that sequence would be a new location, not proof this correction was invalid or permission to suppress validation.

## Integrity

The one-file Git before/after SHA256 values match the delivered manifest. The patch SHA256 is `3e85f8573465f698006d64945e1bfc8fc3d70da9f3d49a4d3039f13ca86b3aae`. SDK primary files inspected on disk match their immutable pinned blobs. Exact source/blob identities and original compressed-log hash are in `/tmp/ifclite-created-zone-8b6-parent-review-hashes.json`. Child-reported syntax-only qualification was not rerun and is not a native numerical pass.
