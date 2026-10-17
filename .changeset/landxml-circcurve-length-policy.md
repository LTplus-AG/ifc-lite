---
'@ifc-lite/create': patch
---

LandXML-to-IFC accepts a profile CircCurve whose declared length is written to three decimals, with the same rule `rust/landxml` applies: `max(1e-6·L, min(5e-4, 2e-4·L))` against the arc or horizontal length, replacing the flat 1 cm. A centimetre of disagreement on a long curve is now refused too.
