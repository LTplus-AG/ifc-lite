# Retained curved round 3: native SDK review

Reviewed adapter source at immutable `f7d8f4ed44d2208ca0722717e5ba84fc633829dc`, delivery `/tmp/ifclite-retained-curved-consumption-round3`, against local SDK `c9c5979f04cea8c38213004d4f04df0dcfb40d05`. The child checkout has since advanced to a later HEAD; every inspected adapter file was compared with the requested commit and matches byte-for-byte. Exact inspected hashes and both identities are in `/tmp/ifclite-retained-round3-parent-sdk-review-hashes.json`. SDK tracked source is unchanged; preexisting untracked build/tool directories were not touched.

**No concrete native algorithm/ownership blocker found by static inspection.** No build, test, symbolization, job submission, SDK edit, network call or child agent was started. This is not C++ compilation or numerical qualification.

## Pipe-sweep ownership correction

`disk.cpp` now owns `SmBSplineCurve path`, `SmCircle circle` and the destination `SmBrep` with independent unique_ptrs. This closes the actual temporary-circle ownership hole in the pinned convenience pipe implementation. It is not a different sweep algorithm:

- The pinned `SmPrimitiveCreation::CreatePipeSweep` constructs the canonical XY circle over degrees [0,360], creates a profile pointer array, computes path natural-interval bounding-box size, and passes `size * 0.5 * SM_ZONE_TOL_3D * 100` to `CreateCurveSweep`.
- The replacement uses the same canonical circle, bounding box interval, tolerance expression, null scale inputs, and options: capped ends, nontranslational sweep, move profile centre to path, orient profile perpendicular to path, do not move to profile. The convenience API also constructs `SmPrimitiveCreation(infinite_region,0,true)`; the replacement preserves this.
- The pinned `CreateCurveSweep` first copies the path under SmObjDelete and copies profile inputs as SmBSplineCurves under its own cleanup. `SmCircle` derives through `SmEllipse` from `SmBSplineCurve`, so the real profile passes that cast. Caller-owned circle/path remain valid for the complete call and are released afterward; they are not consumed twice. The Brep is owned before creation begins and deleted on all error exits.

This establishes source-level route/options/tolerance equivalence and RAII ownership. It does not prove equal geometry, leak freedom inside SDK internals, or the success of the new runtime witnesses.

## Bounded decoding and numerical construction

`SweepBegin` admits at most 1 MiB, 8192 fixed-format segments and 128 loops. Format 1 size is exactly `48 + 8*loops + 104*segments`. Format 2 is the rational-path disk recipe, not a general rational planar-region format. Its decoded degree/control/knot bounds, positive weights, strictly increasing unique knots, clamped multiplicities, expanded-knot sum, trim containment and exact byte size precede SDK construction. Length arithmetic is widened; fixed bounds prevent integer-product overflow here. Readers reject nonfinite coefficients and magnitudes above 1e9.

For planar regions, line/arc/circle records become actual SDK curves, preserving order, circular XY basis, signed traversal and radians-to-degrees conversion. Negative intervals reverse parameterization after constructing the bounded SDK arc. Segment connectivity and loop closure use the declared endpoints; explicit multi-loop roles require CCW outer/CW holes. Area integrates lines and circular segments analytically, including normal sign. Inputs are held by unique_ptr before checked SDK status exits. The pinned `SmApiCreateLinearSweep` copies caller curves before its consuming primitive path, so the original input ownership is coherent.

The resulting linear sweep must have faces, be a manifold solid, and match analytic projected volume. Disk construction uses actual Euclidean control points and weights through the pinned `CreateCanonical` API, not sampled fitting. Its trim interval is passed to the SDK and endpoints checked for collapse/closure. The SDK constructor explicitly interprets the supplied points as Euclidean coordinates and keeps the supplied trim domain. Disk output must be manifold with positive finite volume. General rational region records, hollow disks and closed paths are explicitly outside the implemented domain.

These guards bound the transfer payload and basic decoded topology. They do not bound SDK heap/RSS or geometric worst-case work. Manifold plus volume is not an independent self-intersection proof; unsupported self-intersecting input must not be promoted to a qualified authored domain merely because these checks succeed. Target/source qualification remains necessary.

## Units, transforms and transactions

The native contract consumes already-resolved local metre coefficients and derived curve parameters; there is no native IFC parsing or hidden unit inference. Source-frame correctness remains the source owner's responsibility. Opcode 17 reads exactly 16 doubles and rejects trailing bytes. `numerical_rigid_frame` checks finite affine column-major data, orthonormal columns, positive orientation and column-2 cross-product consistency. It calls SetCanonical with translation and the first two columns only after those checks. `ifclite_smlib_transform` copies the input solid, transforms the owned copy and publishes a new handle; failure destroys the copy and leaves the original slot unchanged. Scale/shear/reflection are rejected rather than silently normalized into a supported transform.

A matching non-null commit moves the upload out of session state before decoding/construction; incomplete, malformed or failed commits therefore clean staged bytes and temporary curves/Brep. Invalid chunks discard the matching transaction. Null output intentionally leaves upload ownership active, as documented. The adapter boundary catches SweepFailure and standard exceptions, while RAII retains cleanup. Session/handle/controller delivery races are outside this native review and owned by the runtime reviewer.

## Bootstrap and witness wiring

The corrected pinned Ninja wheel path is `ninja-1.11.1.4.data/scripts`, consistently used both by acquisition chmod and qualify PATH checks. Native/wasm mode lock is acquired before the shared setup lock; setup acquisition happens while both are held, and mode lock remains held through CTest. Nonblocking lock refusal performs no foreign cleanup. Default native/wasm build directories differ. CMake validates the pinned SDK revision and rejects tracked or untracked source changes under the SDK kernel/API trees.

One configuration limitation remains: callers may override `IFCLITE_ADAPTER_BUILD` to the same directory for two different modes/caches; mode locks do not serialize that explicitly aliased build directory. Default paths are safe, and no evidence of such a conflicting invocation was found. Do not claim arbitrary override-path mutual exclusion from the current locking scheme.

CTest really includes the region/disk source files, and execution is wired `adapter main -> run_sweep_tests -> run_sweep_region_tests + run_disk_tests`; these are not uncalled canaries. The region tests query actual retained surface types, sections and bounded ABI transactions. Disk tests query straight/rational circular sweep volume and immutable transform mesh bounds. Those are meaningful authored witnesses when executed, but remain unrun at the reviewed final source.

The delivery receipts inspected contain earlier failed workspace commands and an earlier native qualification attempt that failed during tool acquisition at the obsolete Ninja path, before adapter numerical tests. They do not establish final-source native/browser passing assertions. Required qualification remains admitted native CTest, actual worker transport, browser/WASM target execution and independent geometric/frame oracles at the exact final source. Capability bits denote implementation only; they cannot serve as qualification receipts.
