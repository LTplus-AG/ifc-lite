---
'@ifc-lite/viewer': patch
---

Honour the LENGTHUNIT display override in the 2D section/drawing canvas's on-canvas distance and perimeter labels (#2199 slice).

`0de10a0fd` (#2538) wired `unitDisplayOverrides` through every measure-tool distance readout — `MeasurePanel.tsx`, `MeasurementVisuals.tsx`, `MeasurePointReadout.tsx` — but `Drawing2DCanvas.tsx`'s own measure-line and polygon-area-perimeter labels still called `formatDistance()` with no `overrides` argument, so a user who set feet as their display unit still saw metres there. `Drawing2DCanvas` now accepts a `unitDisplayOverrides` prop (defaulting to `{}`, so the no-override behaviour is unchanged) and threads it into both `formatDistance()` call sites; `Section2DPanel.tsx` reads the override map from the store and passes it down.
