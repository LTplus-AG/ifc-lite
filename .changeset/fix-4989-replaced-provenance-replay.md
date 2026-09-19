---
"@ifc-lite/diff": patch
"@ifc-lite/viewer": patch
---

`lineageOfDiff` now classifies a carried-forward `appliedKeyAliases` entry as `replaced` when its reason carries the `successor:` prefix, instead of always `identity` (issue #4989). This fixes two round trips that previously silently downgraded an accepted successor claim back to `identity`: `ifc-lite diff --accept m --lineage-out l` followed by `--lineage-in l --lineage-out l`, and `--accept m --identity-in m --lineage-out l`. The viewer's Compare export no longer needs its own post-hoc relabel for this — the engine now reports it correctly on its own.
