---
'@ifc-lite/ids': minor
---

Fix `passRate`/`overallPassRate` reporting 100 on a specification (or a
whole report) that fails on cardinality (`minOccurs`/`maxOccurs`) with no
individual entity failures — e.g. three matching entities under
`maxOccurs: 2` each satisfy their own requirements, so the old
`passedCount / totalEntities` formula landed on 100 while `status` was
`'fail'`. `passRate` and `overallPassRate` are now clamped to 0 whenever
the corresponding `status`/`failedSpecifications` says the check failed
and the formula would otherwise disagree with it; a spec that fails on
genuine per-entity requirement failures keeps its real (already `< 100`)
rate. Bumped `minor` because the corrected numbers are consumer-visible —
scripts, dashboards or agents reading `passRate` today may be silently
trusting the old, misleading value.
