---
"@ifc-lite/drawing-2d": minor
---

Section cut polygons now carry the `IfcMaterial` of the layer they cut (`DrawingPolygon.materialId`, from `MeshData.materialId`), so a consumer can hatch or fill a cut by material. Two layers of the same colour but different materials now reconstruct as separate polygons, each with its material, and get the opaque layer base like any multi-layer cut. `materialId` shares the express-id space with `entityId`, so in a federated session it resolves the same way.
