---
"@ifc-lite/create": patch
"@ifc-lite/cli": patch
---

Structural derivation (#9668): every member whose axis passes through a joint is split there, not only the one a free end met, so beams crossing at a column both end on its node; a member running along the joining one is not split. Apply refuses a hand-edited plan whose member starts and ends on the same node, or whose end points are not its nodes' positions, and writes nothing. `ifc-lite derive-structural` can report more curve members than before on models with crossing beams.
