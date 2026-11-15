---
"@ifc-lite/create": patch
---

Derive uses an L profile's stated `CentreOfGravityInX/Y` (which includes its fillets) for the member axis when it agrees with the computed centroid within 10%; a value that does not agree is ignored. T, U and C profiles keep the computed centroid.
