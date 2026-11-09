---
"@ifc-lite/viewer": patch
---

The Model workspace's Column and Curtain Wall tools follow the same "To storey above / Fixed height" default as the Wall tool (#9296): under "To storey above" a column or curtain wall is drawn up to the storey above and recorded attached to it in the same Undo step, so a later level edit resizes it (a curtain wall is laid out again); a typed height makes it fixed. The Beam tool records the attachment when a beam's top lands on the storey above. Every tool now records the binding as relative (`TopBinding` `Relative`).
