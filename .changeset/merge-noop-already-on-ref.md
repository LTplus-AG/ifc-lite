---
"@ifc-lite/merge": patch
"@ifc-lite/collab-server": patch
---

Merging a candidate that is already on the target ref now no-ops (fast-forward with the ref unchanged) instead of refusing with unrelated-base. Published drafts land on their home ref with a declared base equal to the composition they were authored against, which need not be representable on the ref, so re-merging them previously dead-ended. Registry merge previews now also report `ancestor_matched` so clients can warn before an execute would be refused.
