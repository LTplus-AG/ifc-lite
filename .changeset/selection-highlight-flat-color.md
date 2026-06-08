---
"@ifc-lite/renderer": patch
---

Fix selected-object colour bleeding through the selection highlight. The highlight was a fresnel *glow* — `mix(litColor, highlightColor, fresnel * 0.5 + 0.2)` — so at a face viewed head-on the mix factor floored at 0.2, leaving ~80% of the lit object colour visible (e.g. the green IfcSite and red roof slab showed through the blue highlight, as a lighting-dependent gradient). The selection highlight is now a single flat colour, so a selected object reads as one uniform blue with no base-colour bleed and no gradient.
