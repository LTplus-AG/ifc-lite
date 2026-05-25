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

        Self {
            express_id,
            ifc_type,
            positions: mesh.positions,
            normals: mesh.normals,
            indices: mesh.indices,
            color,
            shading_color: None,
        }
    }

    /// Attach an optional SurfaceColour for the GLB exporter's "Shading"
    /// colour source. Callers that have a `geometry_shading_styles` entry
    /// for the mesh's source geometry id should invoke this after `new`.
    pub fn set_shading_color(&mut self, shading: Option<[f32; 4]>) {
        self.shading_color = shading;
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
}

#[wasm_bindgen]
impl MeshCollection {
    /// Get number of meshes
    #[wasm_bindgen(getter)]
    pub fn length(&self) -> usize {
        self.meshes.len()
    }

    /// Get mesh at index
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

    /// Convert local coordinates to world coordinates
    /// Use this to convert mesh positions back to original IFC coordinates
    #[wasm_bindgen(js_name = localToWorld)]
    pub fn local_to_world(&self, x: f32, y: f32, z: f32) -> Vec<f64> {
        vec![
            x as f64 + self.rtc_offset_x,
            y as f64 + self.rtc_offset_y,
            z as f64 + self.rtc_offset_z,
        ]
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
        }
    }

    /// Add a mesh to the collection
    #[inline]
    pub fn add(&mut self, mesh: MeshDataJs) {
        self.meshes.push(mesh);
    }

    /// Create from vec of meshes
    pub fn from_vec(meshes: Vec<MeshDataJs>) -> Self {
        Self {
            meshes,
            rtc_offset_x: 0.0,
            rtc_offset_y: 0.0,
            rtc_offset_z: 0.0,
            building_rotation: None,
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
                })
                .collect(),
            rtc_offset_x: self.rtc_offset_x,
            rtc_offset_y: self.rtc_offset_y,
            rtc_offset_z: self.rtc_offset_z,
            building_rotation: self.building_rotation,
        }
    }
}

impl Default for MeshCollection {
    fn default() -> Self {
        Self::new()
    }
}

/// Zero-copy mesh that exposes pointers to WASM memory
#[wasm_bindgen]
pub struct ZeroCopyMesh {
    mesh: Mesh,
}

#[wasm_bindgen]
impl ZeroCopyMesh {
    /// Create a new zero-copy mesh from a Mesh
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self { mesh: Mesh::new() }
    }

    /// Get pointer to positions array
    /// JavaScript can create Float32Array view: new Float32Array(memory.buffer, ptr, length)
    #[wasm_bindgen(getter)]
    pub fn positions_ptr(&self) -> *const f32 {
        self.mesh.positions.as_ptr()
    }

    /// Get length of positions array (in f32 elements, not bytes)
    #[wasm_bindgen(getter)]
    pub fn positions_len(&self) -> usize {
        self.mesh.positions.len()
    }

    /// Get pointer to normals array
    #[wasm_bindgen(getter)]
    pub fn normals_ptr(&self) -> *const f32 {
        self.mesh.normals.as_ptr()
    }

    /// Get length of normals array
    #[wasm_bindgen(getter)]
    pub fn normals_len(&self) -> usize {
        self.mesh.normals.len()
    }

    /// Get pointer to indices array
    #[wasm_bindgen(getter)]
    pub fn indices_ptr(&self) -> *const u32 {
        self.mesh.indices.as_ptr()
    }

    /// Get length of indices array
    #[wasm_bindgen(getter)]
    pub fn indices_len(&self) -> usize {
        self.mesh.indices.len()
    }

    /// Get vertex count
    #[wasm_bindgen(getter)]
    pub fn vertex_count(&self) -> usize {
        self.mesh.vertex_count()
    }

    /// Get triangle count
    #[wasm_bindgen(getter)]
    pub fn triangle_count(&self) -> usize {
        self.mesh.triangle_count()
    }

    /// Check if mesh is empty
    #[wasm_bindgen(getter)]
    pub fn is_empty(&self) -> bool {
        self.mesh.is_empty()
    }

    /// Get bounding box minimum point
    #[wasm_bindgen]
    pub fn bounds_min(&self) -> Vec<f32> {
        let (min, _) = self.mesh.bounds();
        vec![min.x, min.y, min.z]
    }

    /// Get bounding box maximum point
    #[wasm_bindgen]
    pub fn bounds_max(&self) -> Vec<f32> {
        let (_, max) = self.mesh.bounds();
        vec![max.x, max.y, max.z]
    }
}

impl From<Mesh> for ZeroCopyMesh {
    fn from(mesh: Mesh) -> Self {
        Self { mesh }
    }
}

impl Default for ZeroCopyMesh {
    fn default() -> Self {
        Self::new()
    }
}

/// Instance data for instanced rendering
#[wasm_bindgen]
pub struct InstanceData {
    express_id: u32,
    transform: Vec<f32>, // 16 floats (4x4 matrix)
    color: [f32; 4],     // RGBA
}

#[wasm_bindgen]
impl InstanceData {
    #[wasm_bindgen(getter, js_name = expressId)]
    pub fn express_id(&self) -> u32 {
        self.express_id
    }

    #[wasm_bindgen(getter)]
    pub fn transform(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(&self.transform[..])
    }

    #[wasm_bindgen(getter)]
    pub fn color(&self) -> Vec<f32> {
        self.color.to_vec()
    }
}

impl InstanceData {
    pub fn new(express_id: u32, transform: Vec<f32>, color: [f32; 4]) -> Self {
        Self {
            express_id,
            transform,
            color,
        }
    }
}

/// Instanced geometry - one geometry definition with multiple instances
#[wasm_bindgen]
pub struct InstancedGeometry {
    geometry_id: u64,
    positions: Vec<f32>,
    normals: Vec<f32>,
    indices: Vec<u32>,
    instances: Vec<InstanceData>,
}

#[wasm_bindgen]
impl InstancedGeometry {
    #[wasm_bindgen(getter, js_name = geometryId)]
    pub fn geometry_id(&self) -> u64 {
        self.geometry_id
    }

    #[wasm_bindgen(getter)]
    pub fn positions(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(&self.positions[..])
    }

    #[wasm_bindgen(getter)]
    pub fn normals(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(&self.normals[..])
    }

    #[wasm_bindgen(getter)]
    pub fn indices(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(&self.indices[..])
    }

    #[wasm_bindgen(getter)]
    pub fn instance_count(&self) -> usize {
        self.instances.len()
    }

    #[wasm_bindgen]
    pub fn get_instance(&self, index: usize) -> Option<InstanceData> {
        self.instances.get(index).map(|inst| InstanceData {
            express_id: inst.express_id,
            transform: inst.transform.clone(),
            color: inst.color,
        })
    }
}

impl InstancedGeometry {
    pub fn new(
        geometry_id: u64,
        positions: Vec<f32>,
        normals: Vec<f32>,
        indices: Vec<u32>,
    ) -> Self {
        Self {
            geometry_id,
            positions,
            normals,
            indices,
            instances: Vec::new(),
        }
    }

    pub fn add_instance(&mut self, instance: InstanceData) {
        self.instances.push(instance);
    }
}

/// Collection of instanced geometries
#[wasm_bindgen]
pub struct InstancedMeshCollection {
    geometries: Vec<InstancedGeometry>,
}

#[wasm_bindgen]
impl InstancedMeshCollection {
    #[wasm_bindgen(getter)]
    pub fn length(&self) -> usize {
        self.geometries.len()
    }

    #[wasm_bindgen]
    pub fn get(&self, index: usize) -> Option<InstancedGeometry> {
        self.geometries.get(index).map(|g| InstancedGeometry {
            geometry_id: g.geometry_id,
            positions: g.positions.clone(),
            normals: g.normals.clone(),
            indices: g.indices.clone(),
            instances: g
                .instances
                .iter()
                .map(|inst| InstanceData {
                    express_id: inst.express_id,
                    transform: inst.transform.clone(),
                    color: inst.color,
                })
                .collect(),
        })
    }

    #[wasm_bindgen(getter, js_name = totalGeometries)]
    pub fn total_geometries(&self) -> usize {
        self.geometries.len()
    }

    #[wasm_bindgen(getter, js_name = totalInstances)]
    pub fn total_instances(&self) -> usize {
        self.geometries.iter().map(|g| g.instances.len()).sum()
    }
}

impl InstancedMeshCollection {
    pub fn new() -> Self {
        Self {
            geometries: Vec::new(),
        }
    }

    pub fn add(&mut self, geometry: InstancedGeometry) {
        self.geometries.push(geometry);
    }
}

impl Default for InstancedMeshCollection {
    fn default() -> Self {
        Self::new()
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SYMBOLIC REPRESENTATION DATA STRUCTURES
// ═══════════════════════════════════════════════════════════════════════════

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_zero_copy_mesh_creation() {
        let mesh = ZeroCopyMesh::new();
        assert!(mesh.is_empty());
        assert_eq!(mesh.vertex_count(), 0);
        assert_eq!(mesh.triangle_count(), 0);
    }

    #[test]
    fn test_zero_copy_mesh_pointers() {
        let mesh = ZeroCopyMesh::new();

        // Pointers should be valid even for empty mesh
        assert!(!mesh.positions_ptr().is_null());
        assert!(!mesh.normals_ptr().is_null());
        assert!(!mesh.indices_ptr().is_null());
    }
}
