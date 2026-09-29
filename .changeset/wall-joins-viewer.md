---
"@ifc-lite/create": minor
"@ifc-lite/viewer": patch
---

Walls joined in the Model workspace (#6232). `@ifc-lite/create` reads walls back (`readWallJoinTarget`, `readWallJoinRels`), joins two walls that are already in the store and replaces a pair's existing `IfcRelConnectsPathElements` instead of adding a second (`joinWallsInStore`), and moves wall ends with their joins following (`reshapeWallsInStore`: a dragged corner takes the walls joined there along, every join that touches a moved wall is cut again, a join whose walls no longer meet is removed). `addWallToStore` now writes an `Axis` representation by default (`Axis: false` opts out). In the viewer, chained `wall.place` writes an L at every corner and where the loop closes and a T where a wall ends on another's path, `wall.moveEndpoint` drags a shared corner with both walls, and resize, wall thickness and split keep the Axis and the joins current, each in one undo step.
