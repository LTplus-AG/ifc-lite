---
"@ifc-lite/create": minor
"@ifc-lite/cli": patch
---

Carry physical through-openings, including plan-box profiles extruded in the wall plane, into derived analytical surface members, reporting unsupported openings in the plan. Support validated inner face bounds through the surface member builder's Openings parameter.

Keep rejected openings separate from skipped physical elements in report counts, CLI output and viewer review. Accept opening standard cases, respect derive tolerance at the true plate faces, and exclude carried holes when checking member contact.
