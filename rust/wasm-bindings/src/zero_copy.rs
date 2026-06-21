// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Zero-copy mesh data structures for WASM
//!
//! Enables direct access to WASM memory from JavaScript without copying.

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

/// A single 2D polyline for symbolic representations (Plan, Annotation, FootPrint)
/// Points are stored as [x1, y1, x2, y2, ...] in 2D coordinates
#[wasm_bindgen]
pub struct SymbolicPolyline {
    express_id: u32,
    ifc_type: String,
    /// 2D points: [x1, y1, x2, y2, ...]
    points: Vec<f32>,
    /// Whether this is a closed loop
    is_closed: bool,
    /// World-Y (elevation in world meters) sampled from the placement chain
    /// or the polyline's own 3D IfcCartesianPoint Z component. Lets the JS
    /// hook bucket annotations by elevation instead of by storey id —
    /// important for files like 3DEXPERIENCE's IFC_Annotation.ifc whose
    /// IfcRelAggregates leaves storeys orphaned but encodes the elevation
    /// on each item's geometry.
    world_y: f32,
    /// Representation identifier: "Plan", "Annotation", "FootPrint", "Axis"
    rep_identifier: String,
}

#[wasm_bindgen]
impl SymbolicPolyline {
    /// Get express ID of the parent element
    #[wasm_bindgen(getter, js_name = expressId)]
    pub fn express_id(&self) -> u32 {
        self.express_id
    }

    /// Get IFC type name (e.g., "IfcDoor", "IfcWindow")
    #[wasm_bindgen(getter, js_name = ifcType)]
    pub fn ifc_type(&self) -> String {
        self.ifc_type.clone()
    }

    /// Get 2D points as Float32Array [x1, y1, x2, y2, ...]
    #[wasm_bindgen(getter)]
    pub fn points(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(&self.points[..])
    }

    /// Get number of points
    #[wasm_bindgen(getter, js_name = pointCount)]
    pub fn point_count(&self) -> usize {
        self.points.len() / 2
    }

    /// Check if this is a closed loop
    #[wasm_bindgen(getter, js_name = isClosed)]
    pub fn is_closed(&self) -> bool {
        self.is_closed
    }

    /// Get representation identifier ("Plan", "Annotation", "FootPrint", "Axis")
    #[wasm_bindgen(getter, js_name = repIdentifier)]
    pub fn rep_identifier(&self) -> String {
        self.rep_identifier.clone()
    }

    /// World-Y elevation captured from the placement chain (or first 3D
    /// point's Z component). JS uses this as the canonical bucket key.
    #[wasm_bindgen(getter, js_name = worldY)]
    pub fn world_y(&self) -> f32 {
        self.world_y
    }
}

impl SymbolicPolyline {
    /// Create a new symbolic polyline
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        express_id: u32,
        ifc_type: String,
        points: Vec<f32>,
        is_closed: bool,
        world_y: f32,
        rep_identifier: String,
    ) -> Self {
        Self {
            express_id,
            ifc_type,
            points,
            is_closed,
            world_y,
            rep_identifier,
        }
    }
}

/// A 2D circle/arc for symbolic representations
#[wasm_bindgen]
pub struct SymbolicCircle {
    express_id: u32,
    ifc_type: String,
    /// Center point [x, y]
    center_x: f32,
    center_y: f32,
    /// Radius
    radius: f32,
    /// World-Y elevation (see SymbolicPolyline.world_y).
    world_y: f32,
    /// Start angle in radians (0 for full circle)
    start_angle: f32,
    /// End angle in radians (2*PI for full circle)
    end_angle: f32,
    /// Representation identifier
    rep_identifier: String,
}

#[wasm_bindgen]
impl SymbolicCircle {
    #[wasm_bindgen(getter, js_name = expressId)]
    pub fn express_id(&self) -> u32 {
        self.express_id
    }

    #[wasm_bindgen(getter, js_name = ifcType)]
    pub fn ifc_type(&self) -> String {
        self.ifc_type.clone()
    }

    #[wasm_bindgen(getter, js_name = centerX)]
    pub fn center_x(&self) -> f32 {
        self.center_x
    }

    #[wasm_bindgen(getter, js_name = centerY)]
    pub fn center_y(&self) -> f32 {
        self.center_y
    }

    #[wasm_bindgen(getter)]
    pub fn radius(&self) -> f32 {
        self.radius
    }

    #[wasm_bindgen(getter, js_name = startAngle)]
    pub fn start_angle(&self) -> f32 {
        self.start_angle
    }

    #[wasm_bindgen(getter, js_name = endAngle)]
    pub fn end_angle(&self) -> f32 {
        self.end_angle
    }

    #[wasm_bindgen(getter, js_name = repIdentifier)]
    pub fn rep_identifier(&self) -> String {
        self.rep_identifier.clone()
    }

    /// Check if this is a full circle
    #[wasm_bindgen(getter, js_name = isFullCircle)]
    pub fn is_full_circle(&self) -> bool {
        (self.end_angle - self.start_angle - std::f32::consts::TAU).abs() < 0.001
    }

    /// World-Y elevation captured from the placement chain.
    #[wasm_bindgen(getter, js_name = worldY)]
    pub fn world_y(&self) -> f32 {
        self.world_y
    }
}

impl SymbolicCircle {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        express_id: u32,
        ifc_type: String,
        center_x: f32,
        center_y: f32,
        radius: f32,
        world_y: f32,
        start_angle: f32,
        end_angle: f32,
        rep_identifier: String,
    ) -> Self {
        Self {
            express_id,
            ifc_type,
            center_x,
            center_y,
            radius,
            world_y,
            start_angle,
            end_angle,
            rep_identifier,
        }
    }

    /// Create a full circle
    pub fn full_circle(
        express_id: u32,
        ifc_type: String,
        center_x: f32,
        center_y: f32,
        radius: f32,
        world_y: f32,
        rep_identifier: String,
    ) -> Self {
        Self::new(
            express_id,
            ifc_type,
            center_x,
            center_y,
            radius,
            world_y,
            0.0,
            std::f32::consts::TAU,
            rep_identifier,
        )
    }
}

/// A 2D text annotation (IfcTextLiteral / IfcTextLiteralWithExtent).
///
/// Position is in the same 2D coordinate space as `SymbolicPolyline` (i.e. the
/// floor-plan / annotation overlay's local frame after applying placement +
/// RTC). The text-orientation pair `(cos, sin)` rotates the baseline from the
/// `+x` axis. Height is the IFC font height in model units, scaled by the
/// project's length-unit factor so the renderer can convert directly to world
/// units. Alignment is the IFC `BoxAlignment` string verbatim
/// (`top-left`, `center`, `bottom-right`, …) — the renderer can interpret it.
#[wasm_bindgen]
pub struct SymbolicText {
    express_id: u32,
    ifc_type: String,
    /// Anchor point on the text baseline (model units).
    x: f32,
    y: f32,
    /// Baseline orientation as a (cos, sin) pair. Defaults to (1, 0).
    dir_x: f32,
    dir_y: f32,
    /// Font height in model units (already unit-scaled). Defaults to 1.0 when
    /// IfcTextStyle isn't resolvable.
    height: f32,
    /// UTF-8 text content (decoded from IFC's `\X2\…\X0\` escape sequences).
    content: String,
    /// IFC `BoxAlignment` — empty string when absent. Renderer treats absent
    /// as `"bottom-left"`, matching the IFC default.
    alignment: String,
    /// World-Y elevation captured from the placement chain (see
    /// SymbolicPolyline.world_y for the why).
    world_y: f32,
    /// sRGB straight-alpha colour (0..1). Defaults to dark-grey when no
    /// IfcStyledItem chain resolves a colour. The grid-tag emission path
    /// uses this to render white bubble fills + black outlines + black
    /// tags out of the existing text pipeline (free billboard +
    /// screen-pixel scaling).
    color_r: f32,
    color_g: f32,
    color_b: f32,
    color_a: f32,
    /// Per-instance target screen-pixel cap height. 0 = fall back to the
    /// renderer's global default (~14 px for body text). Grid bubble fills
    /// + outlines emit at a larger value (~30 px) so the bubble stays
    /// proportional to the inscribed tag at every zoom level.
    target_px: f32,
    /// "Plan" | "Annotation" | "FootPrint" | "Axis"
    rep_identifier: String,
}

#[wasm_bindgen]
impl SymbolicText {
    #[wasm_bindgen(getter, js_name = expressId)]
    pub fn express_id(&self) -> u32 { self.express_id }
    #[wasm_bindgen(getter, js_name = ifcType)]
    pub fn ifc_type(&self) -> String { self.ifc_type.clone() }
    #[wasm_bindgen(getter)]
    pub fn x(&self) -> f32 { self.x }
    #[wasm_bindgen(getter)]
    pub fn y(&self) -> f32 { self.y }
    #[wasm_bindgen(getter, js_name = dirX)]
    pub fn dir_x(&self) -> f32 { self.dir_x }
    #[wasm_bindgen(getter, js_name = dirY)]
    pub fn dir_y(&self) -> f32 { self.dir_y }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> f32 { self.height }
    #[wasm_bindgen(getter)]
    pub fn content(&self) -> String { self.content.clone() }
    #[wasm_bindgen(getter)]
    pub fn alignment(&self) -> String { self.alignment.clone() }
    #[wasm_bindgen(getter, js_name = worldY)]
    pub fn world_y(&self) -> f32 { self.world_y }
    #[wasm_bindgen(getter, js_name = colorR)]
    pub fn color_r(&self) -> f32 { self.color_r }
    #[wasm_bindgen(getter, js_name = colorG)]
    pub fn color_g(&self) -> f32 { self.color_g }
    #[wasm_bindgen(getter, js_name = colorB)]
    pub fn color_b(&self) -> f32 { self.color_b }
    #[wasm_bindgen(getter, js_name = colorA)]
    pub fn color_a(&self) -> f32 { self.color_a }
    #[wasm_bindgen(getter, js_name = targetPx)]
    pub fn target_px(&self) -> f32 { self.target_px }
    #[wasm_bindgen(getter, js_name = repIdentifier)]
    pub fn rep_identifier(&self) -> String { self.rep_identifier.clone() }
}

impl SymbolicText {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        express_id: u32,
        ifc_type: String,
        x: f32,
        y: f32,
        dir_x: f32,
        dir_y: f32,
        height: f32,
        content: String,
        alignment: String,
        world_y: f32,
        rep_identifier: String,
    ) -> Self {
        Self::new_styled(
            express_id, ifc_type, x, y, dir_x, dir_y,
            height, content, alignment, world_y,
            [0.05, 0.05, 0.05, 1.0], // default near-black text color
            0.0,                       // 0 → renderer global default target_px
            rep_identifier,
        )
    }

    /// Full constructor with per-instance colour + screen-pixel target.
    /// Used by the grid bubble emission (white fill / black outline) and
    /// by future IfcTextStyle resolution.
    #[allow(clippy::too_many_arguments)]
    pub fn new_styled(
        express_id: u32,
        ifc_type: String,
        x: f32,
        y: f32,
        dir_x: f32,
        dir_y: f32,
        height: f32,
        content: String,
        alignment: String,
        world_y: f32,
        rgba: [f32; 4],
        target_px: f32,
        rep_identifier: String,
    ) -> Self {
        Self {
            express_id,
            ifc_type,
            x,
            y,
            dir_x,
            dir_y,
            height,
            content,
            alignment,
            world_y,
            color_r: rgba[0],
            color_g: rgba[1],
            color_b: rgba[2],
            color_a: rgba[3],
            target_px,
            rep_identifier,
        }
    }
}

/// A 2D filled region (IfcAnnotationFillArea / IfcAnnotationFillAreaOccurrence).
///
/// Stores one outer ring of 2D points plus an offset table indexing inner
/// rings (holes). Both rings are stored flat in `points` so the JS side can
/// view the buffer as one Float32Array. The optional `hatch_*` fields encode
/// IfcFillAreaStyleHatching (line spacing, primary/secondary angles, line
/// width) when the IfcStyledItem chain resolves to a hatching style; absent
/// styles render as a solid fill.
///
/// `holes_offsets` is an inclusive-prefix array describing where each hole
/// begins. The outer ring is implicitly at `points[0..holes_offsets[0]]`
/// (or all points if `holes_offsets` is empty). Each `holes_offsets[i]` is a
/// vertex index, not a byte offset.
#[wasm_bindgen]
pub struct SymbolicFillArea {
    express_id: u32,
    ifc_type: String,
    /// All ring vertices: outer ring, then each hole back-to-back. Format:
    /// [x1, y1, x2, y2, …]
    points: Vec<f32>,
    /// Inclusive prefix of where each hole begins (in vertex indices, not
    /// floats). Empty array = no holes.
    holes_offsets: Vec<u32>,
    /// Fill color (sRGB, 0..1). Defaults to opaque black when no style.
    fill_r: f32,
    fill_g: f32,
    fill_b: f32,
    fill_a: f32,
    /// Whether this fill has a hatching style applied.
    has_hatching: bool,
    /// Hatching primary line spacing in model units. Only valid when has_hatching.
    hatch_spacing: f32,
    /// Hatching primary angle in radians from the +x axis.
    hatch_angle: f32,
    /// Optional secondary angle (cross-hatching). NaN if absent.
    hatch_angle_secondary: f32,
    /// Hatching line width in model units (0 when unspecified).
    hatch_line_width: f32,
    /// World-Y elevation captured from the placement chain or the boundary
    /// curve's IfcCartesianPoint Z components (see SymbolicPolyline.world_y).
    world_y: f32,
    rep_identifier: String,
}

#[wasm_bindgen]
impl SymbolicFillArea {
    #[wasm_bindgen(getter, js_name = expressId)]
    pub fn express_id(&self) -> u32 { self.express_id }
    #[wasm_bindgen(getter, js_name = ifcType)]
    pub fn ifc_type(&self) -> String { self.ifc_type.clone() }
    /// Flattened ring vertices.
    #[wasm_bindgen(getter)]
    pub fn points(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(&self.points[..])
    }
    #[wasm_bindgen(getter, js_name = pointCount)]
    pub fn point_count(&self) -> usize { self.points.len() / 2 }
    /// Vertex indices marking the start of each hole. Empty = no holes.
    #[wasm_bindgen(getter, js_name = holesOffsets)]
    pub fn holes_offsets(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(&self.holes_offsets[..])
    }
    #[wasm_bindgen(getter, js_name = holeCount)]
    pub fn hole_count(&self) -> usize { self.holes_offsets.len() }
    #[wasm_bindgen(getter, js_name = fillR)]
    pub fn fill_r(&self) -> f32 { self.fill_r }
    #[wasm_bindgen(getter, js_name = fillG)]
    pub fn fill_g(&self) -> f32 { self.fill_g }
    #[wasm_bindgen(getter, js_name = fillB)]
    pub fn fill_b(&self) -> f32 { self.fill_b }
    #[wasm_bindgen(getter, js_name = fillA)]
    pub fn fill_a(&self) -> f32 { self.fill_a }
    #[wasm_bindgen(getter, js_name = hasHatching)]
    pub fn has_hatching(&self) -> bool { self.has_hatching }
    #[wasm_bindgen(getter, js_name = hatchSpacing)]
    pub fn hatch_spacing(&self) -> f32 { self.hatch_spacing }
    #[wasm_bindgen(getter, js_name = hatchAngle)]
    pub fn hatch_angle(&self) -> f32 { self.hatch_angle }
    #[wasm_bindgen(getter, js_name = hatchAngleSecondary)]
    pub fn hatch_angle_secondary(&self) -> f32 { self.hatch_angle_secondary }
    #[wasm_bindgen(getter, js_name = hatchLineWidth)]
    pub fn hatch_line_width(&self) -> f32 { self.hatch_line_width }
    #[wasm_bindgen(getter, js_name = worldY)]
    pub fn world_y(&self) -> f32 { self.world_y }
    #[wasm_bindgen(getter, js_name = repIdentifier)]
    pub fn rep_identifier(&self) -> String { self.rep_identifier.clone() }
}

impl SymbolicFillArea {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        express_id: u32,
        ifc_type: String,
        points: Vec<f32>,
        holes_offsets: Vec<u32>,
        fill_rgba: [f32; 4],
        world_y: f32,
        rep_identifier: String,
    ) -> Self {
        Self {
            express_id,
            ifc_type,
            points,
            holes_offsets,
            fill_r: fill_rgba[0],
            fill_g: fill_rgba[1],
            fill_b: fill_rgba[2],
            fill_a: fill_rgba[3],
            has_hatching: false,
            hatch_spacing: 0.0,
            hatch_angle: 0.0,
            hatch_angle_secondary: f32::NAN,
            hatch_line_width: 0.0,
            world_y,
            rep_identifier,
        }
    }

    /// Builder method: attach a hatching style to an existing fill area.
    pub fn with_hatching(
        mut self,
        spacing: f32,
        angle: f32,
        angle_secondary: Option<f32>,
        line_width: f32,
    ) -> Self {
        self.has_hatching = true;
        self.hatch_spacing = spacing;
        self.hatch_angle = angle;
        self.hatch_angle_secondary = angle_secondary.unwrap_or(f32::NAN);
        self.hatch_line_width = line_width;
        self
    }
}

/// Collection of symbolic representations for an IFC model
#[wasm_bindgen]
pub struct SymbolicRepresentationCollection {
    polylines: Vec<SymbolicPolyline>,
    circles: Vec<SymbolicCircle>,
    texts: Vec<SymbolicText>,
    fills: Vec<SymbolicFillArea>,
}

#[wasm_bindgen]
impl SymbolicRepresentationCollection {
    /// Get all express IDs that have symbolic representations
    #[wasm_bindgen(js_name = getExpressIds)]
    pub fn get_express_ids(&self) -> Vec<u32> {
        let mut ids: Vec<u32> = self
            .polylines
            .iter()
            .map(|p| p.express_id)
            .chain(self.circles.iter().map(|c| c.express_id))
            .chain(self.texts.iter().map(|t| t.express_id))
            .chain(self.fills.iter().map(|f| f.express_id))
            .collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    }

    /// Get number of polylines
    #[wasm_bindgen(getter, js_name = polylineCount)]
    pub fn polyline_count(&self) -> usize {
        self.polylines.len()
    }

    /// Get number of circles/arcs
    #[wasm_bindgen(getter, js_name = circleCount)]
    pub fn circle_count(&self) -> usize {
        self.circles.len()
    }

    /// Get number of text annotations
    #[wasm_bindgen(getter, js_name = textCount)]
    pub fn text_count(&self) -> usize { self.texts.len() }

    /// Get number of fill areas
    #[wasm_bindgen(getter, js_name = fillCount)]
    pub fn fill_count(&self) -> usize { self.fills.len() }

    /// Get total count of all symbolic items
    #[wasm_bindgen(getter, js_name = totalCount)]
    pub fn total_count(&self) -> usize {
        self.polylines.len() + self.circles.len() + self.texts.len() + self.fills.len()
    }

    /// Check if collection is empty
    #[wasm_bindgen(getter, js_name = isEmpty)]
    pub fn is_empty(&self) -> bool {
        self.polylines.is_empty()
            && self.circles.is_empty()
            && self.texts.is_empty()
            && self.fills.is_empty()
    }

    /// Get polyline at index
    #[wasm_bindgen(js_name = getPolyline)]
    pub fn get_polyline(&self, index: usize) -> Option<SymbolicPolyline> {
        self.polylines.get(index).map(|p| SymbolicPolyline {
            express_id: p.express_id,
            ifc_type: p.ifc_type.clone(),
            points: p.points.clone(),
            is_closed: p.is_closed,
            world_y: p.world_y,
            rep_identifier: p.rep_identifier.clone(),
        })
    }

    /// Get circle at index
    #[wasm_bindgen(js_name = getCircle)]
    pub fn get_circle(&self, index: usize) -> Option<SymbolicCircle> {
        self.circles.get(index).map(|c| SymbolicCircle {
            express_id: c.express_id,
            ifc_type: c.ifc_type.clone(),
            center_x: c.center_x,
            center_y: c.center_y,
            radius: c.radius,
            world_y: c.world_y,
            start_angle: c.start_angle,
            end_angle: c.end_angle,
            rep_identifier: c.rep_identifier.clone(),
        })
    }

    /// Get text annotation at index.
    #[wasm_bindgen(js_name = getText)]
    pub fn get_text(&self, index: usize) -> Option<SymbolicText> {
        self.texts.get(index).map(|t| SymbolicText {
            express_id: t.express_id,
            ifc_type: t.ifc_type.clone(),
            x: t.x,
            y: t.y,
            dir_x: t.dir_x,
            dir_y: t.dir_y,
            height: t.height,
            content: t.content.clone(),
            alignment: t.alignment.clone(),
            world_y: t.world_y,
            color_r: t.color_r,
            color_g: t.color_g,
            color_b: t.color_b,
            color_a: t.color_a,
            target_px: t.target_px,
            rep_identifier: t.rep_identifier.clone(),
        })
    }

    /// Get fill area at index.
    #[wasm_bindgen(js_name = getFill)]
    pub fn get_fill(&self, index: usize) -> Option<SymbolicFillArea> {
        self.fills.get(index).map(|f| SymbolicFillArea {
            express_id: f.express_id,
            ifc_type: f.ifc_type.clone(),
            points: f.points.clone(),
            holes_offsets: f.holes_offsets.clone(),
            fill_r: f.fill_r,
            fill_g: f.fill_g,
            fill_b: f.fill_b,
            fill_a: f.fill_a,
            has_hatching: f.has_hatching,
            hatch_spacing: f.hatch_spacing,
            hatch_angle: f.hatch_angle,
            hatch_angle_secondary: f.hatch_angle_secondary,
            hatch_line_width: f.hatch_line_width,
            world_y: f.world_y,
            rep_identifier: f.rep_identifier.clone(),
        })
    }

}

impl SymbolicRepresentationCollection {
    pub fn new() -> Self {
        Self {
            polylines: Vec::new(),
            circles: Vec::new(),
            texts: Vec::new(),
            fills: Vec::new(),
        }
    }

    pub fn with_capacity(polyline_capacity: usize, circle_capacity: usize) -> Self {
        Self {
            polylines: Vec::with_capacity(polyline_capacity),
            circles: Vec::with_capacity(circle_capacity),
            texts: Vec::new(),
            fills: Vec::new(),
        }
    }

    pub fn add_polyline(&mut self, polyline: SymbolicPolyline) {
        self.polylines.push(polyline);
    }

    pub fn add_circle(&mut self, circle: SymbolicCircle) {
        self.circles.push(circle);
    }

    pub fn add_text(&mut self, text: SymbolicText) {
        self.texts.push(text);
    }

    pub fn add_fill(&mut self, fill: SymbolicFillArea) {
        self.fills.push(fill);
    }

    /// Convert from the canonical `ifc_lite_processing::SymbolicData`
    /// (issue #843 follow-up — full parity refactor). The WASM-side
    /// extractor now delegates to the processing crate and converts the
    /// result here so the browser and the HTTP server produce bit-
    /// identical symbol streams from one canonical implementation.
    pub fn from_data(data: ifc_lite_processing::SymbolicData) -> Self {
        let mut collection = Self::with_capacity(data.polylines.len(), data.circles.len());
        for p in data.polylines {
            collection.add_polyline(SymbolicPolyline::new(
                p.express_id,
                p.ifc_type,
                p.points,
                p.closed,
                p.world_y,
                p.representation,
            ));
        }
        for c in data.circles {
            collection.add_circle(SymbolicCircle::new(
                c.express_id,
                c.ifc_type,
                c.center_x,
                c.center_y,
                c.radius,
                c.world_y,
                c.start_angle,
                c.end_angle,
                c.representation,
            ));
        }
        for t in data.texts {
            collection.add_text(SymbolicText::new_styled(
                t.express_id,
                t.ifc_type,
                t.x,
                t.y,
                t.dir_x,
                t.dir_y,
                t.height,
                t.content,
                t.alignment,
                t.world_y,
                t.color,
                t.target_px,
                t.representation,
            ));
        }
        for f in data.fills {
            collection.add_fill(SymbolicFillArea::new(
                f.express_id,
                f.ifc_type,
                f.points,
                f.holes_offsets,
                f.fill_color,
                f.world_y,
                f.representation,
            ));
        }
        collection
    }
}

impl Default for SymbolicRepresentationCollection {
    fn default() -> Self {
        Self::new()
    }
}

/// Get WASM memory to allow JavaScript to create TypedArray views
#[wasm_bindgen]
pub fn get_memory() -> JsValue {
    wasm_bindgen::memory()
}
