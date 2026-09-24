---
"@ifc-lite/viewer": patch
---

The opening view no longer frames coordination markers with the model: small clusters detached from the model (such as the `origin` cube and `geo-reference` glyph proxies in the buildingSMART sample files) are left out of the framing, so those samples open on the building instead of at about a tenth of the view (#5387). Home and Fit All share that framing box, so a tiny object far from the model (a marker, a lone shrub) is framed out there too; it stays rendered and inside the clipping and section ranges. A second structure of comparable size is always kept.
