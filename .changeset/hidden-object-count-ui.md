---
"@ifc-lite/viewer": patch
---

Report hidden objects as a count, in the viewport's own style.

The overlay added in #2980 read "1442 of 1446 objects visible" inside a rounded pill with an amber accent. Two things wrong with that.

**It reported the wrong number.** The figure a user acts on is what the viewer is withholding. A ratio makes them subtract to find the four objects that matter. It now reads "4 hidden".

**It did not follow the viewport's design.** The 3D overlays along the bottom edge are deliberately plain: the scale bar and axis helper are bare text at `text-xs text-foreground/80` with no container. The badge instead used `rounded-full` with a border, a backdrop blur, a shadow and `text-amber-500`, which is neither the bottom-row treatment nor a palette colour. It is now styled as its neighbours are.

Counting logic is unchanged; only the reported figure and the presentation.
