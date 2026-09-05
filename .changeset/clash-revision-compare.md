---
'@ifc-lite/clash': minor
'@ifc-lite/viewer': minor
---

Compare a saved clash-run baseline against the current run and see which clashes are new, still open, or no longer detected (#3928).

`@ifc-lite/clash` already shipped `compareClashRuns`, the matching engine for diffing two clash runs by their durable `clashReviewKey`, but it had no viewer, CLI, or sandbox consumer. This adds one: a "Compare clash runs" dialog in the clash panel header lets a coordinator save the current result as a baseline and later compare a fresh run against it.

A raw `compareClashRuns` diff is unsafe to show as-is: it cannot tell "genuinely fixed" apart from "we didn't actually re-check". A dropped rule, a rule whose selector now matches nothing, or a model no longer part of the comparison all make a clash vanish from the current run's results for reasons that have nothing to do with the model getting better. `@ifc-lite/clash` gains `compareClashRevisions`, which wraps `compareClashRuns` and reclassifies an unsafe `resolved` clash into a new `unretested` bucket, so a coordinator is told "unconfirmed" instead of a false "fixed". The viewer dialog surfaces the reason for every `unretested` clash instead of hiding it in a bucket count.

The safety check works at per-element granularity, not just per-rule/per-model: a `resolved` clash is only trusted when BOTH of its elements are confirmed, by durable key, to still be matched by the same rule in the current run (`ClashRuleCoverage.matchedKeysA`/`matchedKeysB`, new fields the engine now records alongside the existing match counts). This also catches a narrowed selector or re-scoped membership filter that drops just one previously-clashing element while the rule's overall coverage stays non-zero, and a durable key (e.g. GlobalId) that was re-minted between exports for the same physical element. Model identity for the missing-model check no longer collapses on a duplicate display name: two models sharing one name are told apart by how many still share it, not by simple set membership.

The viewer's saved-baseline persistence now validates the stored shape (`result.clashes` must be an array) and its schema version before trusting it, instead of handing a structurally-thin corrupted value to the compare engine, which iterates `clashes` directly.

New exports on `@ifc-lite/clash`: `compareClashRevisions`, `ClashRevisionSide`, `ClashRevisionComparison`, `ClashRevisionReasons`.
