<!-- SPDX-License-Identifier: MPL-2.0 -->
# Owned canonical product execution

This stage covers the source scope recorded in
[source-manifest.json](source-manifest.json). [Validation receipts](validation.json) record 5,678 passed native test invocations
across 373 suite reports, zero failures and 47 ignored cases. The freshly built
WASM contract reports 206 passed, zero failed and seven fixture skips. Clippy
passes with warnings denied; committed WASM declarations are unchanged.
Historical receipts retain their original source scope and results.

The canonical private `ProductExecution` owns the decoded job entity, metadata,
ordered type-map work, strategy state, produced meshes and occurrences, and
geometry hasher. The previous `execution.rs` path has been removed. Both native
and browser callers continue through `produce_element_meshes`, which drives this
same synchronous session to completion. This introduces no alternate model load
or mesh publication path.

The shared borrowed `AssemblyJob` view passes identity, entity and metadata to
the existing assemblers without cloning the type-map list for each command.
Appearance precedence, material alternation, palette splits, texture and UV
handling, instance-only occurrences, outward orientation and normals remain in
those assemblers. Type-map order and class tags remain explicit; type products
remain excluded from product hashing. Final fixed colors, degenerate cleanup,
closure retraction and hash publication retain their established ordering.

Owned kernel-budget `ElementState` and degenerate counters retain progress
between synchronous polls. Their temporary installed guards are thread-bound
and cannot be sent between workers. They restore the caller's TLS state on
normal return and unwinding, while retained counters carry the product's own
accumulated work. Router triangle-order mode similarly restores the ambient
setting at a poll boundary. Changes made by a reached extension are captured
for the next product step rather than lost when the caller's mode is restored.
An aborted execution cannot resume or publish.

Diagnostic draining preserves the original strategy boundaries. An abandoned
primary strategy discards its CSG records before the void-aware retry; plain
rescue retains the attempted void failures. Final publication drains once after
fixed colors and before hash publication. Per-poll draining would change the
ordering of processor-grouped records across type maps. The real-map regression
oracle processes alternating direct boolean and CSG roots, emits their actual
block geometry, drains once, and compares its ordered failure records with the
session result. Other qualification checks cover extension-mode capture and
ambient restoration, conditional retries, terminal annotation refusal,
consumed hosts, appearance, hashing and independent TLS scopes.

The session still leases its decoder, router and production context during each
poll. Router diagnostics and caches are not session-owned, so independent
sessions must not interleave the same mutable router owner. There is no public
async session or shared-router execution contract. The source-lifetime transfer
test disposes the original source and transfers owned job state before execution
work, then supplies an independent compatible worker context. It does not prove
migration of a live router, its caches or its diagnostic streams.

Finer mapping and opening commands remain inside reached router operations.
This stage does not activate retained product representations, nor does it
implement reply epochs, frame negotiation, stale-result rejection or
cancellation protocols. The separate eager construction graph also remains
distinct from canonical conditional product execution. Coordinated consumer
and packaging cutover remains further platform work; the exact arithmetic
kernel is unchanged.

[Whole-worker-pool comparisons](default-path-perf.json) retain identical mesh
counts and ordered geometry fingerprints on six real models. Those fingerprints
omit UVs, textures, instances and text metadata. Shared-host timings include
slower candidate samples and do not establish latency non-regression.
[Native peak-RSS measurements](default-path-memory.json) cover three models.
No speedup, memory reduction or complete presentation-equivalence verdict is
established here. Owned job data,
metadata, queued maps, suspended work and accumulated output can coexist with
router caches. Command and traversal bounds do not bound payload bytes, process
memory or worker residency. Measurements must distinguish that retained state
from transport ownership and verify the actual geometry and presentation
contracts before a performance or memory verdict.

The [capability ledger](../../geometry-platform-capabilities.md) remains the
record of outstanding platform coverage. Later qualifications must bind their
own source scope rather than extending earlier receipts by implication.
