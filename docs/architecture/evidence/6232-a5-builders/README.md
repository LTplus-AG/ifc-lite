# In-store profiled members (#6232 A5)

AC20-FZK-Haus with elements added through the in-store builders on the
Erdgeschoss storey: `resolveSpatialAnchor`, then `addBeamToStore`,
`addColumnToStore` and `addMemberToStore` with a `Profile`. The result was
exported with `StepExporter` and reloaded in the viewer (Windows Chrome,
WebGPU).

The elements form a steel platform: HEB (I) columns, then I, U,
rectangular-hollow and T beams, with L and C braces. A circular column, a
circular-hollow column and a default rectangular column stand beside it. The
shot was taken from the head of the stack, so it also shows the railing and
stairs from the follow-up PR.

![Right: profiled frame and braces](right-railing-posts-profiled-frame.png)
