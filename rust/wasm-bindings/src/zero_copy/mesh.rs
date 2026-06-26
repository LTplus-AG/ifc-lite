// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_geometry::Mesh;
use wasm_bindgen::prelude::*;

/// Individual mesh data with express ID and color (matches MeshData interface)
#[wasm_bindgen]
pub struct MeshDataJs {
    express_id: u32,
    ifc_type: String, // IFC type name (e.g., "IfcWall", "IfcSpace")
    positions: Vec<f32>,
    normals: Vec<f32>,
    indices: Vec<u32>,
    /// Apparent rendering colour: IfcSurfaceStyleRendering.DiffuseColour
    /// when authored, otherwise the SurfaceColour.
    color: [f32; 4], // RGBA
    /// SurfaceColour, populated only when the file authored a distinct
    /// DiffuseColour (so the two would differ). Consumed by the GLB
    /// exporter's "Shading" colour-source option; renderers ignore it.
    shading_color: Option<[f32; 4]>,
    /// Per-vertex texture coordinates (u, v pairs, 1:1 with positions),
    /// present only for textured meshes (#961). Empty otherwise.
    uvs: Vec<f32>,
    /// Decoded RGBA8 texture (`width*height*4`), present only for textured
    /// meshes (#961). Empty otherwise. The browser uploads this verbatim to a
    /// GPU texture — no image decoding happens in JS.
    texture_rgba: Vec<u8>,
    texture_width: u32,
    texture_height: u32,
    texture_repeat_s: bool,
    texture_repeat_t: bool,
    /// Geometry provenance for the viewer's Model/Types view switch:
    /// 0 = occurrence (a placed IfcProduct), 1 = orphan type geometry (an
    /// IfcTypeProduct RepresentationMap with NO occurrence — buildingSMART
    /// annex-E showcase files; part of "the model" since nothing else renders
    /// it), 2 = instanced type geometry (an IfcTypeProduct that IS instantiated
    /// via IfcRelDefinesByType — the type-library shape, hidden in Model mode to
    /// avoid double-rendering, shown in Types mode). See #957 follow-up.
    geometry_class: u8,
    /// Per-element local-frame origin (f64), in the SAME (WebGL Y-up) frame as
    /// `positions`: world position of vertex i = `origin + positions[3i..]`.
    /// Default `[0,0,0]` means positions are absolute (legacy). Carries the
    /// per-element AABB-centre relativization so building-scale coordinates stay
    /// f32-precise (no fan collapse). See `Mesh::origin`/transform_mesh_world_framed.
    origin: [f64; 3],
}

#[wasm_bindgen]
impl MeshDataJs {
    /// Get express ID
    #[wasm_bindgen(getter, js_name = expressId)]
    pub fn express_id(&self) -> u32 {
        self.express_id
    }

    /// Get IFC type name (e.g., "IfcWall", "IfcSpace")
    #[wasm_bindgen(getter, js_name = ifcType)]
    pub fn ifc_type(&self) -> String {
        self.ifc_type.clone()
    }

    /// Get positions as Float32Array (copy to JS)
    #[wasm_bindgen(getter)]
    pub fn positions(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(&self.positions[..])
    }

    /// Get normals as Float32Array (copy to JS)
    #[wasm_bindgen(getter)]
    pub fn normals(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(&self.normals[..])
    }

    /// Get indices as Uint32Array (copy to JS)
    #[wasm_bindgen(getter)]
    pub fn indices(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(&self.indices[..])
    }

    /// Get color as [r, g, b, a] array
    #[wasm_bindgen(getter)]
    pub fn color(&self) -> Vec<f32> {
        self.color.to_vec()
    }

    /// Optional SurfaceColour for the "Shading" GLB-export choice — only
    /// present when the file authored a distinct DiffuseColour. JS sees
    /// `undefined` when absent (most files).
    #[wasm_bindgen(getter, js_name = shadingColor)]
    pub fn shading_color(&self) -> Option<Vec<f32>> {
        self.shading_color.map(|c| c.to_vec())
    }

    /// Get vertex count
    #[wasm_bindgen(getter, js_name = vertexCount)]
    pub fn vertex_count(&self) -> usize {
        self.positions.len() / 3
    }

    /// Get triangle count
    #[wasm_bindgen(getter, js_name = triangleCount)]
    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    /// True when this mesh carries a surface texture (#961).
    #[wasm_bindgen(getter, js_name = hasTexture)]
    pub fn has_texture(&self) -> bool {
        !self.texture_rgba.is_empty()
    }

    /// Per-vertex texture coordinates as Float32Array (u, v pairs). Empty when
    /// the mesh is untextured.
    #[wasm_bindgen(getter)]
    pub fn uvs(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(&self.uvs[..])
    }

    /// Decoded RGBA8 texture bytes (`width*height*4`). Empty when untextured.
    #[wasm_bindgen(getter, js_name = textureRgba)]
    pub fn texture_rgba(&self) -> js_sys::Uint8Array {
        js_sys::Uint8Array::from(&self.texture_rgba[..])
    }

    #[wasm_bindgen(getter, js_name = textureWidth)]
    pub fn texture_width(&self) -> u32 {
        self.texture_width
    }

    #[wasm_bindgen(getter, js_name = textureHeight)]
    pub fn texture_height(&self) -> u32 {
        self.texture_height
    }

    /// Sampler wrap for the S axis (`IfcSurfaceTexture.RepeatS`): true = repeat.
    #[wasm_bindgen(getter, js_name = textureRepeatS)]
    pub fn texture_repeat_s(&self) -> bool {
        self.texture_repeat_s
    }

    /// Sampler wrap for the T axis (`IfcSurfaceTexture.RepeatT`): true = repeat.
    #[wasm_bindgen(getter, js_name = textureRepeatT)]
    pub fn texture_repeat_t(&self) -> bool {
        self.texture_repeat_t
    }

    /// Geometry provenance for the viewer's Model/Types switch (#957 follow-up):
    /// 0 = occurrence, 1 = orphan type geometry (no occurrence), 2 = instanced
    /// type geometry (hidden in Model mode, shown in Types mode).
    #[wasm_bindgen(getter, js_name = geometryClass)]
    pub fn geometry_class(&self) -> u8 {
        self.geometry_class
    }

    /// Per-element local-frame origin (Float64Array[3], WebGL Y-up, metres):
    /// world position of vertex i = `origin + positions[3i..3i+3]`. Returns
    /// [0,0,0] when positions are absolute (legacy / local frame off).
    #[wasm_bindgen(getter)]
    pub fn origin(&self) -> js_sys::Float64Array {
        js_sys::Float64Array::from(&self.origin[..])
    }
}

impl MeshDataJs {
    /// Create new mesh data with IFC Z-up to WebGL Y-up conversion.
    ///
    /// Performs coordinate conversion and winding order reversal in Rust
    /// to avoid expensive per-vertex JS iteration (63.5M vertices for large files).
    /// IFC Z-up → WebGL Y-up: swap Y/Z, negate new Z for right-handedness.
    /// Winding order reversed to compensate for the handedness flip.
    pub fn new(express_id: u32, ifc_type: String, mut mesh: Mesh, color: [f32; 4]) -> Self {
        // Convert positions: IFC Z-up → WebGL Y-up
        for chunk in mesh.positions.chunks_exact_mut(3) {
            let y = chunk[1];
            let z = chunk[2];
            chunk[1] = z; // New Y = old Z (vertical)
            chunk[2] = -y; // New Z = -old Y (depth, negated for right-hand rule)
        }

        // Convert normals the same way
        for chunk in mesh.normals.chunks_exact_mut(3) {
            let y = chunk[1];
            let z = chunk[2];
            chunk[1] = z;
            chunk[2] = -y;
        }

        // Reverse winding order to compensate for handedness flip
        let remainder = mesh.indices.len() % 3;
        let end = mesh.indices.len() - remainder;
        for i in (0..end).step_by(3) {
            mesh.indices.swap(i + 1, i + 2);
        }

        // The per-element origin is a world-frame point and MUST undergo the
        // identical IFC Z-up → WebGL Y-up swap as the positions above, or
        // `world = origin + position` would mix axes (element renders mirrored
        // / displaced). Default [0,0,0] swaps to [0,0,0] (no-op for legacy).
        let origin = [mesh.origin[0], mesh.origin[2], -mesh.origin[1]];

        Self {
            express_id,
            ifc_type,
            positions: mesh.positions,
            normals: mesh.normals,
            indices: mesh.indices,
            color,
            shading_color: None,
            uvs: Vec::new(),
            texture_rgba: Vec::new(),
            texture_width: 0,
            texture_height: 0,
            texture_repeat_s: true,
            texture_repeat_t: true,
            geometry_class: 0,
            origin,
        }
    }

    /// Tag this mesh's geometry provenance for the Model/Types view switch
    /// (0 = occurrence, 1 = orphan type, 2 = instanced type). Call after `new`.
    pub fn set_geometry_class(&mut self, class: u8) {
        self.geometry_class = class;
    }

    /// Attach an optional SurfaceColour for the GLB exporter's "Shading"
    /// colour source. Callers that have a `geometry_shading_styles` entry
    /// for the mesh's source geometry id should invoke this after `new`.
    pub fn set_shading_color(&mut self, shading: Option<[f32; 4]>) {
        self.shading_color = shading;
    }

    /// Attach per-vertex UVs + a decoded RGBA8 texture (#961). UVs are 1:1 with
    /// `positions` and need no coordinate flip (they are 2D); the winding
    /// reversal in `new` swaps indices, not vertices, so per-vertex UVs stay
    /// aligned. Call after `new`.
    pub fn set_texture(
        &mut self,
        uvs: Vec<f32>,
        rgba: Vec<u8>,
        width: u32,
        height: u32,
        repeat_s: bool,
        repeat_t: bool,
    ) {
        self.uvs = uvs;
        self.texture_rgba = rgba;
        self.texture_width = width;
        self.texture_height = height;
        self.texture_repeat_s = repeat_s;
        self.texture_repeat_t = repeat_t;
    }

    /// Build from the canonical per-element producer's [`MeshData`]
    /// (`ifc_lite_processing::element`): wraps [`MeshDataJs::new`] (IFC Z-up →
    /// WebGL Y-up + winding reversal), copies the `geometry_class` tag and the
    /// optional texture/UVs. Element metadata the browser doesn't carry
    /// (global_id / name / presentation layer / material name / properties) is
    /// dropped — the viewer gets it from the parser worker instead.
    pub fn from_mesh_data(m: ifc_lite_processing::MeshData) -> Self {
        let mesh = Mesh {
            positions: m.positions,
            normals: m.normals,
            indices: m.indices,
            // Positions are final here (the canonical producer already applied
            // placement/RTC); the flag only guards upstream double-subtraction.
            rtc_applied: true,
            // Per-element local-frame origin from the producer (IFC frame); the
            // Z-up→Y-up swap is applied in `new`. [0,0,0] when local frame off.
            origin: m.origin,
            // Instancing side-channel is not used on this wasm zero-copy path.
            instance_meta: None,
        };
        let mut js = Self::new(m.express_id, m.ifc_type, mesh, m.color);
        js.set_geometry_class(m.geometry_class);
        if let (Some(uvs), Some(tex)) = (m.uvs, m.texture) {
            js.set_texture(
                uvs,
                tex.rgba,
                tex.width,
                tex.height,
                tex.repeat_s,
                tex.repeat_t,
            );
        }
        js
    }
}

/// Collection of mesh data for returning multiple meshes
#[wasm_bindgen]
pub struct MeshCollection {
    meshes: Vec<MeshDataJs>,
    /// RTC (Relative-to-Center) offset applied to all positions
    /// This is subtracted from world coordinates to improve Float32 precision
    rtc_offset_x: f64,
    rtc_offset_y: f64,
    rtc_offset_z: f64,
    /// Building rotation angle in radians (from IfcSite's top-level placement)
    /// This is the rotation of the building's principal axes relative to world X/Y/Z
    building_rotation: Option<f64>,
    /// Per-entity geometry fingerprints for revision diffing, populated only
    /// when `IfcAPI::set_compute_geometry_hashes` is enabled. Parallel arrays:
    /// `geometry_hash_ids[i]` is the entity express id, `geometry_hash_values[i]`
    /// its fingerprint (see `ifc_lite_geometry::geom_hash`). Empty otherwise.
    geometry_hash_ids: Vec<u32>,
    geometry_hash_values: Vec<u64>,
}

#[wasm_bindgen]
impl MeshCollection {
    /// Get number of meshes
    #[wasm_bindgen(getter)]
    pub fn length(&self) -> usize {
        self.meshes.len()
    }

    /// Get mesh at index (clones — non-destructive). Prefer `takeMesh` on the
    /// hot streaming path; this stays for callers that read meshes more than once.
    #[wasm_bindgen]
    pub fn get(&self, index: usize) -> Option<MeshDataJs> {
        self.meshes.get(index).map(|m| MeshDataJs {
            express_id: m.express_id,
            ifc_type: m.ifc_type.clone(),
            positions: m.positions.clone(),
            normals: m.normals.clone(),
            indices: m.indices.clone(),
            color: m.color,
            shading_color: m.shading_color,
            uvs: m.uvs.clone(),
            texture_rgba: m.texture_rgba.clone(),
            texture_width: m.texture_width,
            texture_height: m.texture_height,
            texture_repeat_s: m.texture_repeat_s,
            texture_repeat_t: m.texture_repeat_t,
            geometry_class: m.geometry_class,
            origin: m.origin,
        })
    }

    /// #1097 perf: MOVE the mesh at `index` out of the collection (the Vec
    /// buffers are `std::mem::take`-n, leaving an empty stub). The streaming
    /// worker reads each mesh exactly once, so moving avoids the full vertex-
    /// data clone `get` pays — one fewer copy of positions/normals/indices/uvs/
    /// texture per mesh (the JS getters still do the single Rust→JS copy). Calling
    /// it twice for the same index yields the second call an empty mesh.
    #[wasm_bindgen(js_name = takeMesh)]
    pub fn take_mesh(&mut self, index: usize) -> Option<MeshDataJs> {
        self.meshes.get_mut(index).map(|m| MeshDataJs {
            express_id: m.express_id,
            ifc_type: std::mem::take(&mut m.ifc_type),
            positions: std::mem::take(&mut m.positions),
            normals: std::mem::take(&mut m.normals),
            indices: std::mem::take(&mut m.indices),
            color: m.color,
            shading_color: m.shading_color,
            uvs: std::mem::take(&mut m.uvs),
            texture_rgba: std::mem::take(&mut m.texture_rgba),
            texture_width: m.texture_width,
            texture_height: m.texture_height,
            texture_repeat_s: m.texture_repeat_s,
            texture_repeat_t: m.texture_repeat_t,
            geometry_class: m.geometry_class,
            origin: m.origin,
        })
    }

    /// Get total vertex count across all meshes
    #[wasm_bindgen(getter, js_name = totalVertices)]
    pub fn total_vertices(&self) -> usize {
        self.meshes.iter().map(|m| m.positions.len() / 3).sum()
    }

    /// Get total triangle count across all meshes
    #[wasm_bindgen(getter, js_name = totalTriangles)]
    pub fn total_triangles(&self) -> usize {
        self.meshes.iter().map(|m| m.indices.len() / 3).sum()
    }

    /// Get RTC offset X (for converting local coords back to world coords)
    /// Add this to local X coordinates to get world X coordinates
    #[wasm_bindgen(getter, js_name = rtcOffsetX)]
    pub fn rtc_offset_x(&self) -> f64 {
        self.rtc_offset_x
    }

    /// Get RTC offset Y
    #[wasm_bindgen(getter, js_name = rtcOffsetY)]
    pub fn rtc_offset_y(&self) -> f64 {
        self.rtc_offset_y
    }

    /// Get RTC offset Z
    #[wasm_bindgen(getter, js_name = rtcOffsetZ)]
    pub fn rtc_offset_z(&self) -> f64 {
        self.rtc_offset_z
    }

    /// Check if RTC offset is significant (>10km)
    #[wasm_bindgen(js_name = hasRtcOffset)]
    pub fn has_rtc_offset(&self) -> bool {
        const THRESHOLD: f64 = 10000.0;
        self.rtc_offset_x.abs() > THRESHOLD
            || self.rtc_offset_y.abs() > THRESHOLD
            || self.rtc_offset_z.abs() > THRESHOLD
    }

    /// Get building rotation angle in radians (from IfcSite placement)
    /// Returns None if no rotation was detected
    #[wasm_bindgen(getter, js_name = buildingRotation)]
    pub fn building_rotation(&self) -> Option<f64> {
        self.building_rotation
    }

    /// Express ids for the per-entity geometry fingerprints, parallel to
    /// [`Self::geometry_hash_values`]. Empty unless geometry hashing was
    /// enabled via `IfcAPI.setComputeGeometryHashes`.
    #[wasm_bindgen(getter, js_name = geometryHashIds)]
    pub fn geometry_hash_ids(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(&self.geometry_hash_ids[..])
    }

    /// Per-entity geometry fingerprints as a `BigUint64Array`, parallel to
    /// [`Self::geometry_hash_ids`]. `u64` is exposed (not hex strings) so JS
    /// can compare with `===` and key maps without allocation. Empty unless
    /// geometry hashing was enabled.
    #[wasm_bindgen(getter, js_name = geometryHashValues)]
    pub fn geometry_hash_values(&self) -> js_sys::BigUint64Array {
        js_sys::BigUint64Array::from(&self.geometry_hash_values[..])
    }

    /// Number of per-entity geometry fingerprints recorded.
    #[wasm_bindgen(getter, js_name = geometryHashCount)]
    pub fn geometry_hash_count(&self) -> usize {
        self.geometry_hash_ids.len()
    }
}

impl MeshCollection {
    /// Create new empty collection
    pub fn new() -> Self {
        Self {
            meshes: Vec::new(),
            rtc_offset_x: 0.0,
            rtc_offset_y: 0.0,
            rtc_offset_z: 0.0,
            building_rotation: None,
            geometry_hash_ids: Vec::new(),
            geometry_hash_values: Vec::new(),
        }
    }

    /// Create new collection with capacity hint
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            meshes: Vec::with_capacity(capacity),
            rtc_offset_x: 0.0,
            rtc_offset_y: 0.0,
            rtc_offset_z: 0.0,
            building_rotation: None,
            geometry_hash_ids: Vec::new(),
            geometry_hash_values: Vec::new(),
        }
    }

    /// Add a mesh to the collection
    #[inline]
    pub fn add(&mut self, mesh: MeshDataJs) {
        self.meshes.push(mesh);
    }

    /// Record a per-entity geometry fingerprint (for revision diffing).
    #[inline]
    pub fn push_geometry_hash(&mut self, express_id: u32, hash: u64) {
        self.geometry_hash_ids.push(express_id);
        self.geometry_hash_values.push(hash);
    }

    /// Create from vec of meshes
    pub fn from_vec(meshes: Vec<MeshDataJs>) -> Self {
        Self {
            meshes,
            rtc_offset_x: 0.0,
            rtc_offset_y: 0.0,
            rtc_offset_z: 0.0,
            building_rotation: None,
            geometry_hash_ids: Vec::new(),
            geometry_hash_values: Vec::new(),
        }
    }

    /// Get number of meshes (internal)
    pub fn len(&self) -> usize {
        self.meshes.len()
    }

    /// Check if collection is empty
    pub fn is_empty(&self) -> bool {
        self.meshes.is_empty()
    }

    /// Set the RTC offset (called during parsing when large coordinates are detected)
    pub fn set_rtc_offset(&mut self, x: f64, y: f64, z: f64) {
        self.rtc_offset_x = x;
        self.rtc_offset_y = y;
        self.rtc_offset_z = z;
    }

    /// Set the building rotation angle in radians
    pub fn set_building_rotation(&mut self, rotation: Option<f64>) {
        self.building_rotation = rotation;
    }

    /// Apply RTC offset to all meshes (shift coordinates)
    /// This is used when meshes are collected first and then shifted
    pub fn apply_rtc_offset(&mut self, x: f64, y: f64, z: f64) {
        self.rtc_offset_x = x;
        self.rtc_offset_y = y;
        self.rtc_offset_z = z;
        for mesh in &mut self.meshes {
            for chunk in mesh.positions.chunks_exact_mut(3) {
                chunk[0] = (chunk[0] as f64 - x) as f32;
                chunk[1] = (chunk[1] as f64 - y) as f32;
                chunk[2] = (chunk[2] as f64 - z) as f32;
            }
        }
    }
}

impl Clone for MeshCollection {
    fn clone(&self) -> Self {
        Self {
            meshes: self
                .meshes
                .iter()
                .map(|m| MeshDataJs {
                    express_id: m.express_id,
                    ifc_type: m.ifc_type.clone(),
                    positions: m.positions.clone(),
                    normals: m.normals.clone(),
                    indices: m.indices.clone(),
                    color: m.color,
                    shading_color: m.shading_color,
                    uvs: m.uvs.clone(),
                    texture_rgba: m.texture_rgba.clone(),
                    texture_width: m.texture_width,
                    texture_height: m.texture_height,
                    texture_repeat_s: m.texture_repeat_s,
                    texture_repeat_t: m.texture_repeat_t,
                    geometry_class: m.geometry_class,
                    origin: m.origin,
                })
                .collect(),
            rtc_offset_x: self.rtc_offset_x,
            rtc_offset_y: self.rtc_offset_y,
            rtc_offset_z: self.rtc_offset_z,
            building_rotation: self.building_rotation,
            geometry_hash_ids: self.geometry_hash_ids.clone(),
            geometry_hash_values: self.geometry_hash_values.clone(),
        }
    }
}

impl Default for MeshCollection {
    fn default() -> Self {
        Self::new()
    }
}
