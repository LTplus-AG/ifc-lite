# Analysis panel type scale (#5821)

Headless Chrome, 1440 × 900, with the built-in authored `building-architecture.ifc` demo loaded (12 geometric elements). The [before](spacemouse-before.png) and [after](spacemouse-after.png) captures open View → SpaceMouse settings on the parent and this branch. The panel fits the same dialog in both captures.

The sensitivity range had no accessible name before this branch. The explicit label now gives it the name “Sensitivity”; the screenshot also shows the shared 11px floor in this panel. Zones and IDS use the same type token and retain their existing control layout.
