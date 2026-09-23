---
"@ifc-lite/collab": patch
---

Fix `applyIfcxOverlay` silently dropping a concurrent peer's deletion. Cross-call overlay tombstones were stored as one JSON array under a single doc key. When two peers tombstoned different paths at the same time, each wrote its whole array, Yjs kept only the last write, and one peer's deletion was lost even though both peers converged. A later layer with no opinion on that path could then resurrect it. Tombstones now live one per path in a dedicated root-level map (`overlay.tombstones.registry`), so concurrent deletions of different paths no longer race.

Migration: a doc written before this change is still honoured. Its legacy `meta` array is read and never written again, and an explicit per-path revival overrides a stale legacy entry. Rollout limit: an old-code peer and a new-code peer editing the same room at the same time are not supported. The old peer only reads the legacy array, which stops being updated, so it will not see tombstones the new peer records. Upgrade every client of a room together.
