---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": patch
---

Wheel zoom toward the cursor now approaches the surface under it instead of passing straight through thin objects (#5393). `Camera.zoom` takes an optional trailing `surfacePoint`: when zooming in toward one, each notch covers a fraction of the remaining distance along the cursor ray and stops short of the surface, keeping it under the cursor. The viewer picks that point once per wheel gesture with `raycastScene`; empty space, zooming out, fast zoom and orthographic keep the previous behaviour.
