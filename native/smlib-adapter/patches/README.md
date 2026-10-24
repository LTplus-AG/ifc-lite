<!-- SPDX-License-Identifier: MPL-2.0 -->
# Versioned SDK build repairs

`imprint-status-v1.patch` marks the upstream file as modified and changes the failed-imprint exit in
`SmTopologyIntersector::IntersectInsertRelate` at SDK revision
`c9c5979f04cea8c38213004d4f04df0dcfb40d05`. It destroys and nulls the owned
prototype manager and returns the **first imprint failure** before
`SetRelationships` or Boolean classification can overwrite it. The healthy
path and relationship-phase return/cleanup are unchanged. Earlier failures in
IntersectTopology/ResolveIntersections and exceptions are outside this patch.

`imprint-status-v1.json` pins the exact patch, input and output file bytes,
complete selected upstream inventory and revision. CMake calls `prepare_sdk.py`
with the immutable `SMLIB_SOURCE` and its binary directory. The script reads and
verifies 494 tracked files (SMLib, SM_API, LICENSE and THIRD_PARTY_NOTICES.md),
rejects modified/extra/ignored files and symlinks, copies bytes to a temporary
build-owned directory, applies the patch with Git and verifies the complete
output inventory before publishing the snapshot. It does not fetch anything.
Existing snapshots must match their complete provenance and bytes; a mismatch
requires a fresh build directory, never an in-place repair or silent fallback.
`SMLIB_SOURCE` is never a patch target. Build and upstream paths must be disjoint.

Only the snapshot supplies kernel/API source and include paths, on native and
Emscripten builds. Its `provenance.json` contains the upstream revision, complete
input digest, patch/input/output digests, preparer/pin-file digests and every
output file's SHA256. CMake exposes the receipt as
`IFCLITE_SDK_PROVENANCE` and copies it to `ifclite-sdk-provenance.json` beside the
build artifacts. Final artifact inventories must bind this receipt to their
actual binary hashes; the upstream revision alone no longer describes the
compiled SDK. This receipt is source provenance, not license clearance or a
runtime qualification result.

The modified upstream file retains its NVIDIA copyright and Apache-2.0 header.
The original LICENSE and THIRD_PARTY_NOTICES.md are copied byte-for-byte; this
adapter's scripts/tests/documentation use MPL-2.0. Preserve the upstream notices
with any eventual authorized redistribution. No publication is performed here.

## Cleanup contract

`ImprintIntersections` continues after failed definitions while retaining its
first error. Failed edge definitions are removed, `Destruct()` frees their
unconsumed curves, and the definitions are deleted (`SmTopologyIntersector.cpp`,
2367-2378). Other definitions can already have modified the operands. The repair
runs the same prototype-manager deletion as the normal completion path, only
before relationship/classification. Its destructor's owned-array deleters
release proto faces, edges and vertices (`SmProtoTopology.cpp:3566-3573`);
edge-definition destructors distinguish consumed face curves from unused edge
curves (`:927-947`). The slot is nulled before returning. The intersector's own
destructor does not own/free this manager (`SmTopologyIntersector.cpp:62-68`),
so replacing the old SE_MSG with a bare SER would leak it.

This is not SDK rollback or proof of leak-free partially modified operands.
The adapter still treats a failed destructive Boolean as terminal uncertainty:
no result publication, no retry, process/module disposal. In particular SDK
context Boolean flags may remain set on the early failure path; the adapter's
existing terminal-domain policy, not context reuse, is required. Nothing here
grants attached-trim mutation authority or persistent face ancestry.

## Actual native witnesses (UNRUN)

`ifclite_smlib_imprint_tests` links one generated, instrumented intersector TU
before the static kernel archive, replacing that TU only in this test executable.
The production kernel contains no test hook. Instrumentation preserves the
upstream header and records actual edge-definition retirement, the call to
SetRelationships, and completion of the actual manager destructor/nulling.

The fixture is two 2-unit cubes offset by (0.5, 0.5, 0.5). Healthy union,
intersection and difference must be manifold and have volumes 12.625, 3.375 and
4.625 (absolute 1e-6), respectively. Healthy classification must produce real
SAVE/DELETE face attributes and preserve both input volumes of 8.

Failure mode skips the first two **actual planned edge imprints**, returning
SM_ERR and SM_ERR_NULL_POINTER, and delegates later definitions to the real
SDK. Thus the operation has genuinely incomplete topology; this is not an
assertion about a standalone mock return. The SDK must retire both failed
definitions and complete other imprints. The original SM_ERR must reach the
Boolean caller, with zero relationship calls, no returned output, and one
manager destruction before return. Scope teardown must not destroy it twice.
In fault mode the relationship-entry observer itself trips the same semantic
assertion if reached, before a mutant can traverse the incomplete graph. This
observes a real forbidden continuation; it does not replace an SDK return.
Failed operands are abandoned by process exit rather than traversed/reused.
This fault tests propagation and lifecycle, not the cause of a naturally failing
IFC model; no such runtime reproduction is claimed.

CTest runs eight process-isolated controls (four operation modes, healthy and
failed), plus the small Python preparation tests. The independent
`imprint_status_mutation_oracle.py` builds a separate test executable generated
by **reversing the production patch to the exact pinned original file hash**.
It runs healthy and fault controls, then requires the reverse to fail with the
specific first-error/no-publication assertion in every mode, followed by fresh
control runs. Compile failure, signal, timeout, unexpected assertion and a
failed healthy control do not count as kills. No production snapshot, immutable
upstream source, shared build source or CI-only runtime switch is mutated.
The workflow invokes this runner and checks its outcome in the final aggregator.

Lightweight copy/patch/pin/reentry checks have run. All C++ compilation, native
witnesses, reverse mutation execution, Emscripten/Worker checks and full inherited
qualification remain **UNRUN**. A green preparation test is not a native pass.

## Parent execution

Use a fresh, parent-owned admitted binary directory; never nest a reservation.
From the exact committed checkout:

```sh
cmake -S native/smlib-adapter -B "$IFCLITE_ADAPTER_BUILD" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DSMLIB_SOURCE=/tmp/ifclite-public-sdk-c9c5979/usd-brep
cmake --build "$IFCLITE_ADAPTER_BUILD" --parallel 2
ctest --test-dir "$IFCLITE_ADAPTER_BUILD" --output-on-failure
python3 native/smlib-adapter/tests/imprint_status_mutation_oracle.py "$IFCLITE_ADAPTER_BUILD"
```

Retain both SDK provenance receipts, test-generation provenance, CMake/toolchain
configuration, binaries/hashes, CTest inventory/results and mutation logs. Run
existing lineage23, diagnostic2, source4, normal/plane/owned, J2/J3 and inherited
61-row/default14 qualification separately as required by the parent. This patch
fixes one SDK status path; it does not complete owned Boolean lineage, mixed
source ancestry, authenticated empty protection, public native/browser wire,
cap removal, or full J5.
