---
"@ifc-lite/bcf": patch
"@ifc-lite/renderer": patch
---

`clippingPlaneToSectionPlane` no longer clamps the section position to 0-100. A clipping-plane location outside the given bounds is a legal BCF cut, and it now comes back as a position below 0 or above 100, so a viewpoint's cut stays where it was written instead of moving onto the nearest bound face. A non-finite location gives the midpoint, 50, as a zero-extent axis already did. Callers that need a 0-100 value must clamp it themselves. The `ViewerSectionPlane.position` and renderer `SectionPlane.position` comments now say that values outside 0-100 are cuts beyond the bounds; the renderer already resolved them linearly.
