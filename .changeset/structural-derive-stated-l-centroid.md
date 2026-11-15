---
"@ifc-lite/create": patch
---

Derive uses an L profile's stated `CentreOfGravityInX/Y` (which includes its fillets) for the member axis when it agrees with the computed centroid within 10%; a value that does not agree is ignored, and so is one on a thin angle where an offset from the centre and a distance from the outer edge are within 20% of each other and the stated value cannot say which it is. T, U and C profiles keep the computed centroid.
