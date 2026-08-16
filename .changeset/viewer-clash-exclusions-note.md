---
'@ifc-lite/viewer': minor
---

Clash exclusions: mark an overlap as by design and stop it counting.

A coordinator can exclude a whole IFC type pair, a one-sided type rule that
excludes every clash involving one type regardless of what it meets, or one
specific element pair. Each rule shows how many clashes it is hiding, and rules
can be disabled or removed. They persist in local storage and apply to the last
run without re-detecting.

This note exists because the feature shipped in #2535 under a changeset that
named only `@ifc-lite/clash`. Consuming a changeset deletes it, so the
viewer-facing description of a viewer feature would otherwise have been lost
from `apps/viewer/CHANGELOG.md` permanently rather than merely delayed.
