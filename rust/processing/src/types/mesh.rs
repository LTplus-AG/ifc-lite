// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Mesh data types for serialization.

use ifc_lite_geometry::InstanceMeta;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A decoded RGBA8 surface texture attached to a mesh (issue #961).
/// Decoded entirely in Rust (`IfcBlobTexture` PNG / `IfcPixelTexture` raw); the
/// browser only uploads `rgba` to a GPU texture — no image logic in TS.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshTextureData {
    /// `width * height * 4` bytes, row-major, top-down, straight alpha.
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// Sampler wrap from `IfcSurfaceTexture.RepeatS/RepeatT`.
    pub repeat_s: bool,
    pub repeat_t: bool,
}

/// Individual mesh data with geometry and metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshData {
    /// Express ID of the IFC element.
    pub express_id: u32,
    /// IFC type name (e.g., "IfcWall").
    pub ifc_type: String,
    /// IFC GlobalId (Root attribute #0) when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub global_id: Option<String>,
    /// IFC Name (Root/Object attribute #2) when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// IFC presentation layer assignment name when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentation_layer: Option<String>,
    /// Vertex positions (x, y, z triplets).
    pub positions: Vec<f32>,
    /// Vertex normals (x, y, z triplets).
    pub normals: Vec<f32>,
    /// Triangle indices.
    pub indices: Vec<u32>,
    /// RGBA color [r, g, b, a] in 0-1 range.
    pub color: [f32; 4],
    /// Optional material/style name resolved from per-item IFC styling.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub material_name: Option<String>,
    /// Optional source geometry item id for submesh outputs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geometry_item_id: Option<u32>,
    /// Optional IFC property set values keyed by IFC property names.
    /// Primarily attached for IfcSpace/IfcZone so downstream tools can build room attribute UIs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub properties: Option<BTreeMap<String, String>>,
    /// Per-vertex texture coordinates (u, v pairs, 1:1 with `positions`),
    /// present only for textured meshes (issue #961).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uvs: Option<Vec<f32>>,
    /// Decoded surface texture, present only for textured meshes (#961).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub texture: Option<MeshTextureData>,
    /// Provenance of the geometry for the viewer's Model/Types switch (#957):
    /// 0 = ordinary occurrence, 1 = orphan type-product RepresentationMap (no
    /// occurrence instantiates it), 2 = instanced type-product map (the type
    /// library shape; its occurrences already draw the real geometry).
    /// Serde-default so existing JSON payloads and disk caches stay readable;
    /// skipped when 0 so ordinary meshes serialize byte-identically.
    #[serde(default, skip_serializing_if = "geometry_class_is_occurrence")]
    pub geometry_class: u8,
    /// Per-mesh local origin (world/RTC frame, f64). `positions` are stored
    /// RELATIVE to this — the world position of a vertex is `origin + position` —
    /// so building/georef-scale placement never collapses adjacent vertices to
    /// bit-identical f32. The renderer applies it as a per-mesh translation
    /// (camera-relative). `[0, 0, 0]` ⇒ positions are absolute (legacy/local).
    /// Serde-default + skip-when-zero so existing payloads/caches stay readable
    /// and local meshes serialize byte-identically.
    #[serde(default, skip_serializing_if = "origin_is_zero")]
    pub origin: [f64; 3],
    /// GPU-instancing metadata (rep-identity + per-occurrence world transform),
    /// attached only when `IFC_LITE_INSTANCING` is on and the element is a clean
    /// single-item mapped instance. Purely in-memory for the native streaming
    /// path — `#[serde(skip)]` because instancing is recomputed fresh each load
    /// and never round-trips through the JSON/disk cache.
    #[serde(skip)]
    pub instance: Option<InstanceMeta>,
}

fn geometry_class_is_occurrence(class: &u8) -> bool {
    *class == 0
}

fn origin_is_zero(origin: &[f64; 3]) -> bool {
    origin[0] == 0.0 && origin[1] == 0.0 && origin[2] == 0.0
}

impl MeshData {
    /// Create a new MeshData from geometry components.
    pub fn new(
        express_id: u32,
        ifc_type: String,
        positions: Vec<f32>,
        normals: Vec<f32>,
        indices: Vec<u32>,
        color: [f32; 4],
    ) -> Self {
        Self {
            express_id,
            ifc_type,
            global_id: None,
            name: None,
            presentation_layer: None,
            positions,
            normals,
            indices,
            color,
            material_name: None,
            geometry_item_id: None,
            properties: None,
            uvs: None,
            texture: None,
            geometry_class: 0,
            origin: [0.0; 3],
            instance: None,
        }
    }

    /// Attach GPU-instancing metadata (see the `instance` field).
    pub fn with_instance(mut self, instance: Option<InstanceMeta>) -> Self {
        self.instance = instance;
        self
    }

    /// Tag the geometry's provenance for the Model/Types view switch (#957).
    pub fn with_geometry_class(mut self, geometry_class: u8) -> Self {
        self.geometry_class = geometry_class;
        self
    }

    /// Set the per-mesh local origin (positions are relative to it).
    pub fn with_origin(mut self, origin: [f64; 3]) -> Self {
        self.origin = origin;
        self
    }

    /// Attach per-vertex UVs + a decoded surface texture (issue #961).
    /// `uvs` must be 1:1 with `positions` (2 floats per vertex).
    pub fn with_texture(mut self, uvs: Vec<f32>, texture: MeshTextureData) -> Self {
        self.uvs = Some(uvs);
        self.texture = Some(texture);
        self
    }

    /// Set element-level IFC metadata.
    pub fn with_element_metadata(
        mut self,
        global_id: Option<String>,
        name: Option<String>,
        presentation_layer: Option<String>,
    ) -> Self {
        self.global_id = global_id;
        self.name = name;
        self.presentation_layer = presentation_layer;
        self
    }

    /// Set material name and source geometry item id metadata.
    pub fn with_style_metadata(
        mut self,
        material_name: Option<String>,
        geometry_item_id: Option<u32>,
    ) -> Self {
        self.material_name = material_name;
        self.geometry_item_id = geometry_item_id;
        self
    }

    /// Attach optional IFC property set values.
    pub fn with_properties(mut self, properties: Option<BTreeMap<String, String>>) -> Self {
        self.properties = properties;
        self
    }

    /// Get the number of vertices.
    pub fn vertex_count(&self) -> usize {
        self.positions.len() / 3
    }

    /// Get the number of triangles.
    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    /// Check if the mesh is empty.
    pub fn is_empty(&self) -> bool {
        self.positions.is_empty() || self.indices.is_empty()
    }
}
