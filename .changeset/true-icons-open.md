---
"@ifc-lite/drawing-2d": minor
---

Add the optional `SectionConfig.clipProjectionBands` setting to clip mesh projections and hidden-line occluders to the configured visible and overhead depth bands before outlining them. This keeps geometry crossing a finite depth boundary from projecting its out-of-band footprint. Existing callers retain their current behavior when the setting is omitted.
