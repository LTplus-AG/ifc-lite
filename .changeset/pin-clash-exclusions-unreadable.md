---
'@ifc-lite/viewer': patch
---

Pin `loadExclusions`'s unreadable-entry recovery guard with the same coverage its three sibling loaders (presets, reviews, settings) already had: corrupt JSON, an empty stored string, the quota-exhausted-backup path, and a later clean read clearing the latch.

While auditing the three siblings, the same "clean read clears the flag" guard turned out to be unpinned for all four loaders — no existing test killed a mutation removing `unwritableKeys.delete(...)` from the top of `readStoredPresets`, `loadReviews`, or `loadSettings` either. Added one targeted test per loader.

Also pinned (not fixed) a real behavioral difference: unlike its three siblings, which distinguish a missing key (`raw === null`) from an empty stored string, `loadExclusions` uses `if (!raw)`, so an empty string is treated as "no entry" rather than a read failure — it is never backed up and never blocks the next write. No production code changed; this is coverage only.
