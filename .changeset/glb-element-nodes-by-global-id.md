---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
"@ifc-lite/cli": minor
---

GLB export can name element nodes by `GlobalId` (#9011). With the new opt-in option, each IFC element becomes one node directly under the scene, named by its `GlobalId`, with that element's mesh parts as its children. A window's frame and glass, or a layered wall, are then one named node instead of several unrelated siblings, so tools that identify objects by node name (as IfcConvert's `--use-element-guids` output allows) can map a picked or loaded object back to its element. Each element node carries a copy of the scene root's translation and site rotation, so every part lands exactly where it does without the option, and geometry, accessors, materials and the binary chunk are unchanged. An element without a usable `GlobalId` keeps its own node, unnamed.

The option is off by default, and output without it is unchanged. Turn it on with `ifc-lite export model.ifc --format glb --name-by-global-id --out model.glb`, the new trailing `nameByGlobalId` parameter of `GeometryProcessor.exportGlb`, the new wasm method `exportGlbNamedByGlobalId` (same parameters as `exportGlb`, whose signature is unchanged), or `GltfOptions::with_name_by_global_id(true)` in Rust. It applies to the in-memory GLB, the bounded large-model GLB and the multi-buffer `.gltf` alike.

The glTF guide's metadata example no longer shows a node `name`: before this option, exported nodes never carried one.
