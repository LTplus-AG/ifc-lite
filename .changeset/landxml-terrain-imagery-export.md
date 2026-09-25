---
"@ifc-lite/create": minor
"@ifc-lite/export": minor
"@ifc-lite/wasm": minor
"@ifc-lite/viewer": minor
---

Carry draped terrain imagery into the LandXML → IFC4X3 export (#5942, mapping spec v1.4 §15.5).

- `@ifc-lite/create`: `landXmlToIfc` implements mapping v1.4. A new `imagery` option records the draped image as provenance in `LandXML_Conversion` (`ImagerySourceFileName`, `ImagerySourceHash`, `ImageryPlacement`, `ImageryCrs`, `ImageryProjection`, `ImageryCoveredFraction`, and for a transcode `ImageryShippedFileName`/`ImageryShippedHash`), and the result names each written surface's `IfcGeographicElement` in `surfaceElements`.
- `@ifc-lite/wasm`: the appearance planner (`planAppearance`) and the geometry router's textured path accept `IfcTriangulatedIrregularNetwork` bodies, the terrain subtype of `IfcTriangulatedFaceSet`, so a TIN can be textured and a textured TIN renders with its image.
- `@ifc-lite/export`: `serializeEntityArgs`, the exporter's schema-aware serializer for freshly created entities, is exported.
- `@ifc-lite/viewer`: a LandXML terrain draped with a file image exports as an `.ifcZIP`: the TIN textured by the appearance planner (`IfcImageTexture` + `IfcSurfaceStyleWithTextures` + `IfcIndexedTriangleTextureMap`) and the image beside it, a GeoTIFF shipped as a lossless PNG. The export dialog states the imagery, its covered fraction and an assumed unit it inherits before you commit; map-tile drapes are never exported.
