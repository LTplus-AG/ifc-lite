---
"@ifc-lite/bcf": major
---

Removed `BCFOverlayRenderer` and `BCFOverlayRendererOptions` (#5511, charter #5478). The framework-agnostic DOM overlay class — and the injected `<style>` stylesheet it carried — is gone; the viewer's `BCFOverlay` was its only consumer and now renders markers, connector lines and hover tooltips as `Pin` / `AnchoredCard` primitives on the viewport's shared scene-overlay projector instead of running its own `requestAnimationFrame` polling loop against this class. `computeMarkerPositions` and every other export of `@ifc-lite/bcf` are unchanged — marker *position* computation stays a pure, viewer-agnostic function; only the DOM rendering class is removed. A consumer still wanting a plain-DOM BCF overlay (no React) needs to render markers itself from `computeMarkerPositions`' output.
