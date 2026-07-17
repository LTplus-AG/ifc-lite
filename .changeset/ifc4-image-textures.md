---
'@ifc-lite/parser': minor
'@ifc-lite/geometry': minor
'@ifc-lite/renderer': minor
'@ifc-lite/wasm': minor
---

Render IFC4 `IfcImageTexture` surface textures from `.ifcZIP` containers (#1781).

- parser: new `unwrapIfcZipWithResources` surfaces sibling raster images (the files `IfcImageTexture.URLReference` points at) alongside the model entry, keyed by lowercased basename; `unwrapIfcZip` is unchanged.
- geometry/wasm: `IfcImageTexture` now resolves to a lightweight reference (`textureId` = the `IfcSurfaceTexture` express id, URL, repeat flags) instead of being dropped — the host decodes the image once per id, so a 4096² JPEG shared by dozens of face sets is decoded and uploaded exactly once. `IfcIndexedTriangleTextureMap` with a null `TexCoordIndex` (the SketchUp IFC Manager export shape) now maps UVs 1:1 with the face set's coordinates per spec. Textured face sets on ORDINARY occurrences (direct `Body` items, not just type-product representation maps) now carry UVs + texture through the sub-mesh path, and blob/pixel texture decodes are Arc-shared instead of cloned per face set.
- renderer: textured meshes with an external image reference render through the existing WebGPU textured pipeline via a refcounted shared-texture registry (one GPU texture per `textureId`, uploaded from the viewer-decoded `ImageBitmap`); per-mesh #961 blob/pixel uploads are unchanged.
- viewer: `.ifcZIP` loads decode sibling images with `createImageBitmap` and attach them to arriving meshes; textured models skip the binary geometry cache (which cannot persist textures yet) instead of silently losing textures on the second open.
