---
"@ifc-lite/viewer": patch
---

Elements added in the viewer are now drawn from their IFC by the same mesher that loaded the model (#6232). That covers the Add Element tool, the wall command, Space Sketch rooms and `bim.store.add*` scripts. They land where the file will place them, on storeys that sit away from the model origin and on georeferenced models too. A door or window hosted through `bim.store.addOpening` / `addHostedDoor` / `addHostedWindow` cuts its wall on screen. Collaborators receive the same meshes, and keep receiving them when an add, a wall resize or a split is undone or redone (a redone element used to reach them with only its first mesh). The parameter-built box that used to stand in for a new element is gone; it is now used only for previews while an element is being drawn.
