---
"@ifc-lite/rhino3dm": minor
"@ifc-lite/viewer": patch
---

`readRhino3dm` adds `hiddenByObject` and `hiddenByLayer` to each entity and to every mesh, instance, point cloud, curve and text dot record: the two causes `hidden` folds together, the object's own flag and a layer on its path off. A merged entity's is true only when all its objects' are. `hidden` is unchanged. The fields are required, so code that builds these records by hand must set them. The shared shape is exported as `RhinoImportVisibility`. The viewer uses them so that showing an entity Rhino hides draws a state Rhino can be in: when its least hidden parts all need the same one action (Show Objects, or turning layers on), a part that needs the other too is left out (#10214).
