---
"@ifc-lite/viewer": patch
---

The opening view no longer frames coordination markers with the model: small clusters detached from the model (such as the `origin` cube and `geo-reference` glyph proxies in the buildingSMART sample files) are left out of the framing, so those samples open on the building instead of at about a tenth of the view (#5387).
