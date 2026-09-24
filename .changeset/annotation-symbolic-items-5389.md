---
"@ifc-lite/wasm": patch
---

Stop reporting an IfcAnnotation's curves and text as dropped geometry (#5389). An annotation's `Annotation2D` / `Surface2D` representation is meshed only for its fill areas; the curve sets, polylines and text literals beside them are drawn by the symbolic-annotation layer, but they were still walked by the mesher and counted as dropped representation items, so a clean model warned "missing or incomplete" (293 items on AC20-FZK-Haus). They are now skipped in those representations, the fills still mesh, and an unsupported item in a Body representation is still reported. Mesh output is unchanged.
