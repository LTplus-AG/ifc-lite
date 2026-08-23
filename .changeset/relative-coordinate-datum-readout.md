---
"@ifc-lite/viewer": patch
---

Make the Measure tool's relative-coordinate readout distinguishable from an absolute one, and show the datum it is measured from (#2737 §3).

The temporary reference point itself already shipped: a store field and a subtraction feeding one "Rel. ref" row. Two things about how that row read are fixed here.

The offset printed as `X 3.000  Y 4.000  Z 4.000` — character for character the shape every absolute coordinate the viewer shows uses (model-local, project/anchor, render-frame world, georeferenced). Only the small label cell beside it said otherwise, and a label cell is what a narrow panel or a screenshot crop loses. It now prints as signed per-axis deltas, `ΔX +3.000  ΔY +4.000  ΔZ +4.000`, so the distinction is carried in the value and survives being read out of context. A zero axis stays unsigned: an offset of nothing has no direction.

The datum was also never displayed, only implied by the delta row's existence — an offset whose origin is off-screen or forgotten is a number nobody can act on. A **Datum** row now shows the reference point's own position, in the same frame and the same format as the Model row above it, because that is what it is: a point somebody picked. Both rows are derived from the store on every render, so moving the reference recomputes the offset in place and clearing it removes both rows rather than leaving their last numbers on screen.

No change to when the datum is kept or dropped, to the absolute rows when no datum is set, or to the georeferenced projection.
