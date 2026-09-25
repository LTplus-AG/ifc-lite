---
"@ifc-lite/viewer": patch
---

Viewport overlay colours come from the overlay tokens (#5490). The axis helper, the move gizmo, the placement gizmo and the measure tool's shift-drag constraint axes now share one X/Y/Z triad (the constraint axes also colour the vertical axis as Z, matching the axis helper, where they used to call it Y). The Clash panel's side A / B dots use the same colours as the pair in 3D, and the focused clash's overlap follows the theme. The level-display chip is a neutral HUD chip instead of purple. Measure snap indicators use one accent colour and a distinct glyph per snap kind (the point-cloud snap now has its own glyph instead of a violet dot), finished measurements are drawn in ink and live ones in the accent. Popped-out panels now receive the overlay tokens too.
