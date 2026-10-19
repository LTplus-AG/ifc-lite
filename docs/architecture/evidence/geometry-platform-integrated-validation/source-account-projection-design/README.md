<!-- SPDX-License-Identifier: MPL-2.0 -->
# Actual account projection: reviewed implementation contract

The read-only proposal is pinned to source26354 and the independent review to source59fac; their inspected resource boundary bytes match. The private native allocator tests and wasm32 test-target compilation succeeded at26354, while broader source/platform qualification remains open.

The implementation owner is now building the coherent resource boundary: preserve the original context payload and account downcast; derive payload and projection from one Arc<T>; use the same actual account and checked live-byte category, direct captured terminal observer and authenticated decoder/work gate. No arbitrary projection attachment, ambient-account fallback, per-allocation permit table, source authority from a resource trait or new parser activation is authorized. The review's early-fault forwarding, lock/destructor ordering, retained metadata lifetime and double-charge corrections are mandatory.

This contract does not complete source/cache/Raw ownership migration or regularized-region production binding. The implementation remains separate, unreviewed and unexecuted until its frozen source is delivered. The permanent exact/default contract remains unchanged.
