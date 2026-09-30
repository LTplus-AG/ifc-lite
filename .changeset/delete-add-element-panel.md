---
"@ifc-lite/viewer": minor
---

The Add element panel and the Space Sketch tool are gone: every kind is now a command in the Model workspace (Author ribbon, Model; or press E). Wall, Slab (also roof and plate), Column, Beam (also member), Room, Opening, Door, Window, Stair and Railing each pick on the storey with snapping and a live ghost, then commit as one undo step. Room does what Space Sketch and Auto Spaces did: pick, draw, Auto on a storey or every storey, Edit the layout, Footprint and Show leaks. Doors and windows are placed on a wall (hosted), never free-standing. The two Author ribbon buttons, the palette row "Add Element", their keyboard shortcuts (Enter, Esc and S in the panel, Ctrl+Z and Enter in the sketch) and the sketch's plan card are removed; Start blank on the welcome card still lands in the wall tool. `bim.store.*` and scripts are unchanged.
