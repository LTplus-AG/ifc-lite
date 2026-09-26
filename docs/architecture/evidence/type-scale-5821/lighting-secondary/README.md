# Lighting and secondary controls type scale (#5821)

Headless Chrome at 1440 × 900 loaded the authored SketchUp `building-architecture.ifc` demo on the parent and this branch. The viewer reported 12 elements and showed the model hierarchy in both captures. The [before](environment-before.png) and [after](environment-after.png) images show the docked Environment panel with cast shadows and manual time of day enabled.

The Sun time and shadow Softness label rows computed at 9px before and 12px after. Both sliders remain in the same order and width. Their accessible names are now explicit on the range inputs because the rows also contain independent Reset buttons. The remaining changed secondary controls use the same 12px text token.
