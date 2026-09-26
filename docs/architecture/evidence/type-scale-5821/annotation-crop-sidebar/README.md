# Annotation, PDF crop, and sidebar type scale (#5821)

Headless Chrome at 1440 × 900 loaded the authored `building-architecture.ifc` demo (12 elements) on the parent and this branch. The [before](sidebar-before.png) and [after](sidebar-after.png) captures open the sidebar customizer in the same viewport. Its Reset control changed from 10px to the shared 12px `text-xs` token; the panel keeps its 256px width and footer visible.

The same token replaces the remaining 9.5–11px labels and note text in the annotation popover and PDF crop controls. The PDF crop drawing surface retains its focus and pointer capture behavior.
