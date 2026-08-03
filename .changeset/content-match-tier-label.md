---
'@ifc-lite/diff': minor
---

Report WHICH tier produced each content match (#1891). `ContentMatch` gains an optional `tier: ContentMatchTier` — `'geometry-hash'` (tier 1, an agreeing world geometry hash), `'residue-1-1'` (tier 2, the 1:1 leftover resting on the data hash alone), `'positional'` (tier 3, mutual nearest neighbour on bounding-box centres), or `'unresolved'` (a reported `duplicated`/`deduplicated`/`ambiguous` group, which retires nothing).

`kind` says what the pass claims happened; `tier` says on what evidence, and the two are independent. A `renamed` can come from an agreeing world hash or from the pass's one destructive path — the same record, two very different amounts of evidence — so a consumer that wants to weigh a match, or a validation harness that wants to score the tiers separately, had no way to tell them apart. Inference does not close the gap: `renamed`-with-equal-hashes is reachable from both tier 1 and tier 3, which is exactly the ambiguity that matters on a model full of repeated components.

Additive and optional, so existing consumers are unaffected. Every record the pass emits now carries it.
