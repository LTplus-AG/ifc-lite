---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
"@ifc-lite/renderer": minor
---

Render IFC surface textures on tessellated geometry (#961).

`IfcBlobTexture` (embedded PNG **and** JPEG) and `IfcPixelTexture` (raw pixel
literals) are now decoded to RGBA8 entirely in Rust (the `png` and
`jpeg-decoder` crates) and the per-triangle `IfcIndexedTriangleTextureMap` /
`IfcTextureVertexList` coordinates are emitted as per-vertex UVs in lockstep with
the flat-shaded tessellation (the authored texture coordinates are used directly,
mapping the image ~1:1 like the buildingSMART reference; the whole-shell
orientation flip is mirrored onto the texture indices so UVs stay aligned). The
decoded RGBA + UVs ride on `MeshData` across the wasm boundary; the WebGPU
renderer gains a dedicated textured pipeline that uploads the texture and draws
textured meshes in their own sub-pass, preserving picking, section-clipping and
flat-shading. The buildingSMART annex-E "tessellated shape with style" boilers
now render textured instead of flat white.

All image/texture decoding lives in Rust so the server, CLI and SDK get the same
result — the browser only uploads the bytes to the GPU. `IfcImageTexture`
(external URL) remains out of scope (needs an async fetch resolver).
