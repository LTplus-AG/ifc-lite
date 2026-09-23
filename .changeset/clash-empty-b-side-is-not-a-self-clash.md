---
"@ifc-lite/wasm": major
"@ifc-lite/clash": patch
---

Fix a clash rule whose B side matches nothing running as a self-clash of A on the WASM backend. A rule that named a B side (by `b` selector or by `membersB`) which resolved to zero elements reported A-vs-A pairs instead of no clashes; on an MEP-only model a "pipes vs building elements" rule returned 1,892 pipe-vs-pipe false positives. The TS backend was already correct, so the two backends disagreed.

The cause was an ambiguous kernel contract rather than a missing check: `ClashSession::run_rule` encoded "self-clash" as an *empty* `group_b`, so "the caller named no B side" and "the caller named a B side that matched nothing" arrived as the same call. The orchestrator had the distinction (`number[] | null`) and carried it correctly all the way to the FFI boundary, where marshalling flattened both to a zero-length array.

Self-clash is now an explicit absence: `group_b` is `Option<&[u32]>` in Rust and a nullable `Uint32Array` on the `ClashSession.runRule` binding. `None`/omitted is a self-clash; `Some`, **including an empty array**, is a two-sided rule. This also fixes a latent second instance of the same conflation, where a two-sided rule whose B indices were all out of range was filtered down to an empty list and became a self-clash.

`@ifc-lite/clash` users are unaffected except that the bug is gone — `WasmClashEngine` and the `ClashRule` type are unchanged, and omitting `b` is still how you ask for a self-clash.

**Breaking for direct `@ifc-lite/wasm` consumers only:** `ClashSession.runRule(groupA, groupB, …)` previously treated an empty `groupB` as a request for a self-clash. It now treats it as a B side with no members, which yields no clashes. Callers relying on the old encoding must pass `undefined` (or `null`) for `groupB` instead of an empty `Uint32Array`.
