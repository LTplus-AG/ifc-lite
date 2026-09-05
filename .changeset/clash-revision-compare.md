---
'@ifc-lite/clash': minor
'@ifc-lite/viewer': minor
---

Compare a saved clash-run baseline against the current run and see which clashes are new, still open, or no longer detected (#3928).

`@ifc-lite/clash` already shipped `compareClashRuns`, the matching engine for diffing two clash runs by their durable `clashReviewKey`, but it had no viewer, CLI, or sandbox consumer. This adds one: a "Compare clash runs" dialog in the clash panel header lets a coordinator save the current result as a baseline and later compare a fresh run against it.

A raw `compareClashRuns` diff is unsafe to show as-is: it cannot tell "genuinely fixed" apart from "we didn't actually re-check". A dropped rule, a rule whose selector now matches nothing, or a model no longer part of the comparison all make a clash vanish from the current run's results for reasons that have nothing to do with the model getting better. `@ifc-lite/clash` gains `compareClashRevisions`, which wraps `compareClashRuns` and reclassifies any clash caught by one of those three conditions from `resolved` into a new `unretested` bucket, so a coordinator is told "unconfirmed" instead of a false "fixed". The viewer dialog surfaces the reason for every `unretested` clash instead of hiding it in a bucket count.

New exports on `@ifc-lite/clash`: `compareClashRevisions`, `ClashRevisionSide`, `ClashRevisionComparison`, `ClashRevisionReasons`.
