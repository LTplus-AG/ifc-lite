<!-- SPDX-License-Identifier: MPL-2.0 -->
# Authenticated retained product removal

The disabled retained transaction API can publish a whole-product removal when
ordered numerical Difference receipts and exact authored source containment
prove that every host part was removed. Initially empty products, unsupported
Empty outcomes and partial products do not qualify. Exact remains the default;
refusal never retries automatically with exact.

Native callers complete the shared `RuntimeProductExecution` issue/execute/accept
loop, then call `publish_removed` with the original decoder, router and Worker.
The non-cloneable `PublishedRetainedRemoval` identifies the committed product;
`into_output` consumes it into zero meshes and zero instance occurrences, with
the final diagnostics. No destination/reapply API exists. The controller accepts
only one terminal attempt, including a refused or unwound attempt.

For browser callers, `RetainedBrowserProduct.execute` uses this same publication
path for authenticated removal. Its summary has outcome
`authenticated_whole_product_removal` and `final_product_available: true`.
`takeRemovedProduct()` transfers the typed `RetainedRemovedProduct` once, exposing
`productId` and `outcome`. Finalization failures have `code` (`source`, `protocol`,
`unsupported`, `runtime`, or `stopped`) and `message`. Earlier admission/execution
errors retain their existing API contract. Other products still yield only an
intermediate witness; no nonempty final geometry is made available.

This initial terminal domain refuses files containing authored style, material,
texture, colour, presentation or type-inheritance records, even unrelated ones.
It also refuses captured appearance indexes, material-layer obligations and
malformed record framing. This is conservative evidence of absence, not a claim
that removed products excuse malformed dependencies. The source scan is bounded
and reads raw records without lazy geometry decoding. Layered/styled removal
requires future validated source evidence; it is not silently accepted here.

With that absence established, there are no surviving material regions,
interfaces, caps, display surfaces, normals, UVs, face identifiers or instances.
Placement and opening closure remain authenticated by the source-bound removal
proof and sealed ordered receipts. Every ledger receipt, source lifecycle,
Worker incarnation, decoder/router lease and original resource context is checked
again at terminal acceptance. The final diagnostic drain uses the existing
publication quarantine on refusal or unwind. The consumed-host flag is inserted
only after owner commits and final checks; no fallible callback or allocation
follows it. A later cancellation does not revoke an already accepted result.

This is not full J2 or release completion. Nonempty appearance, cap removal,
face identity, instancing, viewer/CLI activation, numerical qualification and
licensing gates remain mandatory. Generated WASM declarations must be regenerated
with `scripts/build-wasm.sh` before integration qualification; never edit package
types manually.
