---
"@ifc-lite/viewer": patch
---

Compare mode gains a **Suggestions** section (issue #4955): successor claims ("Replaced · footprint 0.81 · 0.02 m · agrees on Pset_WallCommon"), split/merge claims and the unresolved content groups, each with its evidence line. A successor row, or a 1:1 pair picked out of an ambiguous group, can be accepted (an in-session identity-map entry, replayed as `keyAliases` on the instant re-diff so the pair classifies by key) or marked "Not the same" (hidden for the session). The panel exports the accepted identity map and the lineage as sidecars pinned to the two files' `sha256:` digests, and imports an identity map back, refusing one written for other bytes. Telemetry counts `respecified` matches, successor and split/merge claims, and records accept / reject decisions.
