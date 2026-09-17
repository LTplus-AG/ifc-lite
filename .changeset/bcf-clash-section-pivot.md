---
"@ifc-lite/viewer": patch
---

BCF viewpoints no longer carry a section plane the user cannot see. Opening the Section tool turns its cut on, and leaving the tool hid the cut while the flag stayed on, so every later topic (including the Clash panel's "BCF topic" button) exported a `<ClippingPlanes>` that BIMcollab and usBIM then applied. Viewpoints now include a clipping plane only while the Section tool is showing the cut; Capture 2D still records its section. While a clash is focused with nothing selected, orbiting now turns around the clashing pair instead of the geometry under the cursor or the model centre; selecting something or unfocusing the clash restores pick-to-pivot.
