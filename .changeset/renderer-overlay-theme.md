---
"@ifc-lite/renderer": major
---

`Renderer.setOverlayTheme(theme: OverlayTheme)` replaces every hardcoded overlay colour with one call the app makes on theme change: the selection highlight (was the WGSL constant `vec3<f32>(0.3, 0.6, 1.0)`), the section-plane preview accent (was per-axis Material colours plus a custom violet `#9C6BDE`), every overlay line channel and the section-cut outline, and the clash pair / overlap tints. The GPU uniforms it drives are written only on this call, never per frame.

`Renderer.setOverlayLineColor` is removed (superseded by `setOverlayTheme`'s `overlayLine` field) — a breaking change for any consumer calling it directly; migrate to `renderer.setOverlayTheme({ ...DEFAULT_OVERLAY_THEME, overlayLine: yourColor })` (also exported: `OverlayTheme`, `DEFAULT_OVERLAY_THEME`). `RenderPipeline` gains `updateSelectionColor`.
