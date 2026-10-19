# Frozen affine source review

Reviewed commit: `51be982755442ed8e5889430adf7292dfbd92f5c`.
Base: `e98406f5dffe4591e41b80d8fc841e29a1b056ab`.
Scope: the 19 changed paths listed in source-hashes.json, read from exact Git objects. SDK source inspected at `/tmp/ifclite-public-sdk-c9c5979/usd-brep`, pin `c9c5979f04cea8c38213004d4f04df0dcfb40d05`; relevant file hashes recorded separately in that manifest. Later commit `6cb45f3aed` and working changes are excluded. This is a source review, not compilation, runtime, geometry, platform, performance, or production qualification. No source edits or heavy jobs were performed.

## P2: deep-copy success is not propagated

Candidate `native/smlib-adapter/src/affine.cpp:153–155` calls `SmApiBrepCopy(source, raw)`, checks its status, and checks only that the returned pointer is nonnull. That wrapper cannot expose the actual topology-copy failure.

Pinned evidence:

- `source/SM_API/src/SmApiQueries.cpp:1011` onward: wrapper constructs `new (*SmApiGetOrCreateContext()) SmBrep(...)`, returns error only for null, then returns `SM_SUCCESS`.
- `source/SMLib/src/SmBrep.cpp:673`: copy constructor executes `SE(MergeBrep(crBrepToCopy, pOptCopyBrepMap, pOptReverseMap, bAddAnalytics));`.
- `source/SMLib/inc/SmMessages.h:223`: debug `SE` signals errors and continues. At line 627 release `SE` is `#define SE(a) ((void)(a))`; the returned status is discarded.
- `source/SMLib/src/SmBrep.cpp:22961` onward: `MergeBrep` uses `SER` for surface copying and topology insertion; the later edge/UV-trim copy stage also uses `SER` and can return early. `SER` returns a failed status, unlike `SE`.
- `source/SMLib/inc/SmBrep.h:1204`: `MergeBrep` is publicly available with the preserve-representation flag.

Failure scenario: an SDK operation inside MergeBrep returns a failed status after some topology was copied. The constructor and API wrapper still return a nonnull partial BRep with successful wrapper status. Subsequent candidate inspections validate encountered classes and finite coefficients/vertices, not source-to-copy topology completeness. They cannot establish that the full source was copied; an empty or partial collection can pass those checks.

Minimal repair: allocate a context-owned independent empty BRep under an owning guard and call checked public `MergeBrep(source, ..., FALSE)`, explicitly preserving source tolerance metadata. Refuse and destroy the copy before conversion on any copy error. An equivalent checked-copy helper is also appropriate. Do not modify the SDK. Review all users if adopting a shared helper, but this frozen finding is scoped to the new affine call. This is a source-proven failure-propagation gap, not an observed runtime failure.

## Optional hardening: effective placement reconstruction

Candidate factor() checks reconstruction from SVD arrays before constructing SmAxis2Placement values. SetCanonical can normalize supplied X/Y axes and derives Z by cross product. Check the effective two placement frames, signed diagonal scale, and translation against the original matrix after construction if the documented reconstruction policy is intended to bound the actual supplied transform. Do not invent a certified geometric error bound from the current factor residual. This is a hardening recommendation, not an independently demonstrated numerical failure.

## Positive observations

- Column-major input and A = U D Vt factor ordering are consistent with pinned SmMatrix::SVDecompose. Reflection signs are absorbed into signed diagonal scale, leaving proper placement frames.
- Pinned SmBrep::Transform(axis, scale, FALSE) has explicit reflection edgeuse/shell corrections. Candidate avoids the matrix overload's unchecked SVD and analytic recognition path.
- Exact-rationalizable class whitelist excludes the pinned TurnToNURBS offset fitting and nonrational edge approximation branches. Read-only knot checks address known copy normalization thresholds; absent materialized rational data is explicitly refused.
- Native and browser receipts retain input identity, original matrix, conversion certificate and immutable source request, with actual owner/object liveness. Native explicit session-owned release rather than retiring Drop is intentional and documented.
- Private browser protocol response checks and independent-copy handle checks are consistent with the stated candidate seam. No caller-supplied response injection or automatic exact-kernel fallback was added in the inspected delta.
- Existing C ABI witnesses use independent inverse coordinates, determinant volume, inverse-transpose orientation and edge incidences; their source presence is not proof that they execute or pass.

## Remaining completion gates

Actual SDK compile/CTest, browser runtime/cancellation tests, retained mapped-source coverage, common product transaction integration, persistent presentation/faces and the broader excluded-class/extreme-scale preservation gaps remain open. Box/cylinder witnesses cannot prove those requirements. Historical 4/4 CTest and 21-region evidence belongs to earlier source and does not qualify this extension.
