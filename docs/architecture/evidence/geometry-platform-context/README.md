<!-- SPDX-License-Identifier: MPL-2.0 -->
# Mapping control and owned model context

Qualification is pending for the [frozen combined source](source-manifest.json).
Historical ownership and scene receipts retain their original source scope.

This stage owns mapped-source continuation frames and immutable per-chunk/batch
production contexts through the shared native, browser and appearance producer.
The exact kernel remains permanent and default. Complete source lowering,
source/index bundle binding, effect envelopes, resource limits, retained execution
and all-consumer/platform qualification remain open.

## Initial binding fidelity rejection

The initial combined source passes the existing high-level WASM checks, but its
[generated low-level ABI comparison](rejected-binding-abi.json) detects four
changed calling conventions. That is not full API preservation. The
[WASM receipt](wasm-consumer.json) and [Python receipt](python-consumer.json)
retain their exact source scope. A corrected binding layer requires its own
source manifest and fresh checks; these passing counts cannot qualify it.

The [native run](rejected-native-ratchet.json) stopped after 4,776 passing test
invocations when two removed mapped functions still had allowance rows. It is
not a full workspace pass. The
[corrected candidate](../geometry-platform-context-restored/) has a separate
immutable source manifest and requires fresh qualification.
