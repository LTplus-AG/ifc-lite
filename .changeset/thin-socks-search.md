---
"@ifc-lite/viewer": major
---

Add Curtain Wall and Grid commands to the Model workspace, command palette and keyboard shortcuts (#6232). Curtain walls create meshed members and panels, while grids create tagged design axes with a live authored-grid overlay and design-grid snapping. Placement, Undo and Redo use the existing modelling transactions.

Breaking change: the viewer's modelling snap module no longer exports `semanticSource`; `modelSnapSources` is the command pointer's combined wall-axis and design-grid source entry point. The versioned viewer package announces this removed export with a major release.
