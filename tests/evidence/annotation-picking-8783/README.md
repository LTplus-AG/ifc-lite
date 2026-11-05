# Annotation picking (#8783)

Definition of done:

- Curves, filled regions and labels select their owning IfcAnnotation through the normal click path, both below and above the 500-mesh hydration budget.
- Lines have a four-CSS-pixel hit tolerance, independent of device pixel ratio.
- Hidden, isolated-away, section-clipped, cropped and non-drawable RTE content cannot be selected. Fill holes remain holes. Labels disappear with their anchor, matching rendering.
- Owner identity survives partition splitting, federation, placement and large world coordinates. Grid/reference overlays remain unowned.
- Upload replacement, clearing and device destruction invalidate retained targets and pending readbacks.
- An annotation-free pick performs no additional projection or geometry traversal.
- Behavioral regressions pass, real authoring-tool content supplies an oracle, and an adversarial review resolves findings before acceptance.

Implementation uses one screen-space/triangle hit tester for both picking routes. It retains owner identity on the existing uploads, reuses fill triangulation and the text pipeline's actual atlas layout, applies the shader's camera-dependent glyph scale and depth lift, and resolves overlay hits against mesh depth. Because overlays don't write depth, their draw order breaks overlapping-overlay hits. Label targets are the rendered glyph quads (including their halo), not individual opaque font texels; whitespace between glyph quads is not a target. Marquee selection is outside this click-picking issue.

Public model: [#653 attachment](https://github.com/LTplus-AG/ifc-lite/issues/653), `IFCAnnotationTest.zip`, containing `IFC_Annotation.ifc` and `IFC_Model.ifc`. The IFC header identifies the exporter as 3DEXPERIENCE Platform IFC4. Model data is not committed.

Validation results and adversarial findings will be recorded here after execution.
