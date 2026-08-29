---
'@ifc-lite/clash': patch
---

Fix `compareClashRuns` (clash revision lifecycle) reporting every still-open clash as resolved-then-added on the very next comparison, instead of `persistent`.

`compareClashRuns` matched clashes between the "previous" and "next" run by the raw `clash.id`. `engine-ts/orchestrator.ts`'s `clashId()` folds `ClashElement.model` into that id (`${model} ${key}`), and `review.ts` documents `model` as an ephemeral per-load id assigned by the host app — which is exactly why `review.ts`'s own durable key, `clashReviewKey`, deliberately excludes it. Two loads of identical geometry (precisely the "model revision" scenario this module exists to diff) therefore produced two different `clash.id`s for the same real-world clash, so a clash that was still open on the next run was reported as `resolved` (from the previous run) and `added` (in the next run) instead of `persistent` — defeating the point of revision tracking and burying any genuinely new or resolved clash in spurious churn.

`compareClashRuns` now matches by `clashReviewKey` (rule id + the two elements' durable keys, order-independent) instead of `clash.id`. Output shape and the `persistent` bucket's "report the next run's Clash" behaviour are unchanged; only the matching key changed, so a clash detected across two loads with a stable `model` (e.g. a fixed per-session or per-file id) is unaffected — this only corrects diffs across a `model` change.
