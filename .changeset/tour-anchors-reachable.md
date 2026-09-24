---
"@ifc-lite/viewer": patch
---

The IDS tour works again. Since the Data validation panel opens on two entry cards, the tour could not find Load IDS File, Run Validation or the results, so every step after "open the panel" was skipped as broken. The tour now switches the panel to its IDS side first, and the panel remembers the side you last picked (IDS or Information validation) for the session. Tours also open a step's panel themselves when it is closed, so skipping a tour's "open the panel" step (for example in the Compare tour) no longer breaks every step after it. A new contract test fails when a tour step targets an anchor no component renders (#5608).
