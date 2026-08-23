---
'@ifc-lite/drawing-2d': major
---

Removed the standalone `renderScaleBar` / `renderNorthArrow` sheet renderers
and shrank `ScaleBarConfig` / `NorthArrowConfig` to the fields that are
actually read.

`sheet/scale-bar-renderer.ts` exported a second, richer pair of scale-bar and
north-arrow renderers that no code in this repository called — only the barrel
re-exports and two documentation snippets referred to them. Sheets are drawn by
the private pair inside `title-block-renderer.ts` (`renderScaleBarInTitleBlock`,
`renderNorthArrowInTitleBlock`), reached through `renderTitleBlock`'s `extras`
argument, and mirrored on screen by the viewer's `Drawing2DCanvas`. Those two
live renderers draw one alternating-segment metric bar with `0`/end labels and
a fixed-position north glyph; they ignore most of the configuration the deleted
file honoured.

Verified by running: a sample sheet export — 1458 sheets covering three paper
sizes, three frame styles, three title-block layouts and all three title-block
positions, each rendered with `renderFrame` + `renderTitleBlock(..., extras)`
exactly as the viewer's SVG sheet export composes it, and with the removed
config fields deliberately varied — is byte-identical before and after this
change (13,656,906 bytes, sha256
`a2a2ce27b6d17474b6a8f4d7e16184c52a16385698dd5cf343151903743034c5`). Every one
of those sheets contains a `title-block-scale-bar` and a
`title-block-north-arrow` group, so the sample does exercise the live path.

Removed exports:

- `renderScaleBar`, `renderNorthArrow` — the dead renderers.
- `PositionMm` — a parameter type used only by those two functions.
- `ScaleBarStyle`, `ScaleBarPosition`, `ScaleBarUnits` — enum aliases whose only
  purpose was typing `ScaleBarConfig` fields that are also removed here. Judged
  part of the same cut rather than left as orphans; they had no other referent.
- `ScaleBarConfig.style`, `.position`, `.customOffset`, `.units`,
  `.subdivisions`, `.labelFontSize`, `.showUnitLabel` — the live renderer draws
  alternating metric segments at a fixed title-block position with a hard-coded
  1.8mm label size and no unit label, so none of these were consulted.
- `NorthArrowConfig.positionMm` — the arrow is placed at a fixed offset in the
  title block.

`NorthArrowStyle` and `NorthArrowConfig.style` are kept: the live path reads
`style` to decide whether to draw the arrow at all (`'none'` suppresses it), and
the viewer's north-arrow toggle writes it.

Major rather than patch because published exports and interface fields are
removed: a consumer that imported `renderScaleBar` or set one of the dropped
config fields now gets a compile error. Consumers spreading `DEFAULT_SCALE_BAR`
or `DEFAULT_NORTH_ARROW` are unaffected.

No test coverage is lost — neither renderer had any test. Note that this leaves
the surviving title-block scale bar and north arrow untested, as they already
were.
