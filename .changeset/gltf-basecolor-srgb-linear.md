---
'@ifc-lite/wasm': patch
---

Fixed the glTF/GLB exporter (`export_glb_from_meshes`, the streaming/bounded and type-library-instanced paths) copying an element's `IfcColourRgb`-sourced colour straight into `pbrMetallicRoughness.baseColorFactor` and `emissiveFactor`. Those two glTF fields are defined in LINEAR colour space (glTF 2.0 spec), while `IfcColourRgb` is authored perceptually — the sRGB convention every BIM colour picker (and IfcOpenShell/BlenderBIM) uses. Without the sRGB→linear transfer function, the emitted GLB rendered too bright/washed-out in any spec-compliant external viewer (Blender, three.js, Cesium — the point of exporting glTF at all). The writer now applies the standard IEC 61966-2-1 decode to the R/G/B channels only; alpha (opacity, not a light quantity) and `alphaMode` are unchanged, and metallic/roughness factors were never colour and stay untouched.
