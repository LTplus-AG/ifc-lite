---
"@ifc-lite/renderer": minor
---

Selection outline through occluders, and a hover pre-highlight ([#5390](https://github.com/LTplus-AG/ifc-lite/issues/5390)). The selection highlight pass used a depth test with no depth write, so a fully occluded selection (a wall under a roof, a duct behind a slab) was completely invisible; hovering only fed a tooltip, off by default, with no visual feedback at all.

A new selection/hover mask pass (`selection-mask-pass.ts`) draws the selected geometry into two small single-sample targets: `maskVisible` (rg8unorm: selected/hovered, visible-only) and `maskAll` (r8unorm: selected, drawn regardless of occlusion). The edge pass from #5385 outlines the mask (`edge-pass.ts`'s new `encodeOutline`, sharing its fullscreen-triangle vertex stage): a solid blue outline on the visible silhouette, a dimmer outline where the selection is hidden behind other geometry, and a thin pre-highlight outline for the hovered entity. The existing re-lit blue highlight fill is unchanged.

- `RenderOptions.hoverOutline?: { id: number; modelIndex?: number } | null` — the entity to pre-highlight (with its federated model), or `null`/absent for none.
- New viewer setting "Hover highlight" (Main toolbar → Helpers), on by default, independent of "Hover tooltips".
