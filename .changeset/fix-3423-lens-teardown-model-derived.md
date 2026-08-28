---
'@ifc-lite/viewer': patch
---

Clear `lensAppliedColors`, `lensAutoColorLegend` and `discoveredLensData` on a session reset — all three are derived from the outgoing model and were missing from `lensTeardown`'s `owns` list, so they survived a new file load. A later shared-colour handoff could reapply the outgoing lens overlay, the new session could show stale legend entries, and discovered lens data from the removed model stayed live.

Refs #3423
