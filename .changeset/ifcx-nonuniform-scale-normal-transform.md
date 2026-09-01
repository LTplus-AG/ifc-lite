---
'@ifc-lite/ifcx': patch
---

Fix a wrong mesh normal under a non-uniform-scale or shearing `usd::xformop`. `extractGeometry` transformed an explicit `usd::usdgeom::mesh` `normals` entry by the same matrix it uses for vertex positions; that only preserves perpendicularity to the surface when the accumulated local-to-world transform is orthogonal (pure rotation/translation). A real PCERT fixture (`tests/models/ifc5/Tunnel_Excavation_07_Invert.ifcx`) carries a `usd::xformop` with a 2x non-uniform scale on one axis composed with a rotation, so a producer that ships explicit normals under such a transform previously came out shaded wrong. Normals now transform by the inverse-transpose of the transform's linear part, per the USD/ifcx spec.
