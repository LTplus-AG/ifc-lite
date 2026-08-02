// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Mesh data types for serialization.

use ifc_lite_geometry::InstanceMeta;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A surface texture attached to a mesh (issues #961, #1781). Exactly one of
/// `rgba` / `url` is set:
/// - `rgba`: decoded in Rust (`IfcBlobTexture` PNG / `IfcPixelTexture` raw);
///   the browser only uploads it to a GPU texture — no image logic in TS.
/// - `url`: an `IfcImageTexture` reference (#1781) the HOST layer resolves —
///   typically a sibling image file inside the `.ifcZIP` container. Real files
///   share one multi-megapixel image across dozens of face sets, so the
///   pipeline ships the reference, never per-mesh pixels.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshTextureData {
    /// Express id of the source `IfcSurfaceTexture` — the stable dedup key:
    /// every mesh sampling the same image carries the same id, so consumers
    /// create ONE GPU texture per id, not one per mesh. 0 in legacy payloads.
    #[serde(default)]
    pub texture_id: u32,
    /// `width * height * 4` bytes, row-major, top-down, straight alpha.
    /// `Arc`-shared across meshes; `None` for an external image reference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rgba: Option<std::sync::Arc<Vec<u8>>>,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    /// `IfcImageTexture.URLReference` verbatim (#1781); `None` for decoded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Sampler wrap from `IfcSurfaceTexture.RepeatS/RepeatT`.
    pub repeat_s: bool,
    pub repeat_t: bool,
}

impl MeshTextureData {
    /// Build from the geometry crate's per-face-set attachment.
    pub fn from_attachment(att: &ifc_lite_geometry::TextureAttachment) -> Self {
        match &att.source {
            ifc_lite_geometry::TextureSource::Decoded(tex) => Self {
                texture_id: att.texture_id,
                rgba: Some(tex.rgba.clone()),
                width: tex.width,
                height: tex.height,
                url: None,
                repeat_s: tex.repeat_s,
                repeat_t: tex.repeat_t,
            },
            ifc_lite_geometry::TextureSource::Image(img) => Self {
                texture_id: att.texture_id,
                rgba: None,
                width: 0,
                height: 0,
                url: Some(img.url.clone()),
                repeat_s: img.repeat_s,
                repeat_t: img.repeat_t,
            },
        }
    }
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
    /// Local (pre-placement, object-space) AABB (issue #1474) — see
    /// `ifc_lite_geometry::Mesh::local_bounds`. Purely in-memory, like
    /// `instance` — `#[serde(skip)]`, recomputed fresh each load.
    #[serde(skip)]
    pub local_bounds: Option<[f32; 6]>,
    /// The resolved `IfcLocalPlacement` chain applied to this mesh (issue
    /// #1474), row-major — see `ifc_lite_geometry::Mesh::local_to_world`.
    /// Purely in-memory, like `instance` — `#[serde(skip)]`.
    #[serde(skip)]
    pub local_to_world: Option<[f64; 16]>,
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
            local_bounds: None,
            local_to_world: None,
        }
    }

    /// Attach GPU-instancing metadata (see the `instance` field).
    pub fn with_instance(mut self, instance: Option<InstanceMeta>) -> Self {
        self.instance = instance;
        self
    }

    /// Set the local (pre-placement, object-space) AABB (see `local_bounds`).
    pub fn with_local_bounds(mut self, local_bounds: Option<[f32; 6]>) -> Self {
        self.local_bounds = local_bounds;
        self
    }

    /// Set the resolved placement transform (see `local_to_world`).
    pub fn with_local_to_world(mut self, local_to_world: Option<[f64; 16]>) -> Self {
        self.local_to_world = local_to_world;
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

/// #1623 Phase 2 "don't-bake": a non-template occurrence of a shared
/// `IfcRepresentationMap` that skipped the per-occurrence vertex materialize. The
/// router emits an instance-only placeholder (empty geometry carrying
/// `InstanceMeta`); [`crate::element::emit_sub_meshes`] turns it into one of these,
/// and the streaming finalize resolves it against the template MeshData into an
/// [`InstanceRecord`]. Purely in-memory (recomputed each load), never serialized.
#[derive(Debug, Clone)]
pub struct RawInstanceOccurrence {
    /// This occurrence's IFC element id.
    pub express_id: u32,
    /// IFC type name (e.g. "IfcFlowFitting").
    pub ifc_type: String,
    /// IFC GlobalId when available.
    pub global_id: Option<String>,
    /// IFC Name when available.
    pub name: Option<String>,
    /// IFC presentation layer assignment name when available.
    pub presentation_layer: Option<String>,
    /// This occurrence's resolved RGBA colour.
    pub color: [f32; 4],
    /// Shared-template key = the `IfcRepresentationMap` express id. Matches the
    /// template MeshData's `instance.rep_identity`.
    pub rep_identity: u128,
    /// PRE-RTC composed world transform (row-major) `transform · local · canonical`
    /// — the same composition `collate_refs` computes for a baked occurrence, but
    /// captured WITHOUT materializing vertices. The finalize reduces it to the
    /// post-RTC frame and derives the template-relative `InstanceRecord.transform`.
    pub world_transform: [f64; 16],
}

/// #1623 Phase 2: one resolved occurrence of a shared template geometry, emitted in
/// [`crate::ProcessingResult::instances`] instead of a full materialized mesh when
/// `StreamingOptions.enable_instancing` is set. The consumer uploads the template
/// MeshData (`template_express_id`, still in `meshes`) once and draws this occurrence
/// by applying `transform` to the template's baked world geometry. Purely in-memory,
/// like [`MeshData::instance`] — recomputed fresh each load, never round-trips a cache.
#[derive(Debug, Clone)]
pub struct InstanceRecord {
    /// This occurrence's IFC element id.
    pub express_id: u32,
    /// IFC type name (e.g. "IfcFlowFitting").
    pub ifc_type: String,
    /// IFC GlobalId when available.
    pub global_id: Option<String>,
    /// IFC Name when available.
    pub name: Option<String>,
    /// IFC presentation layer assignment name when available.
    pub presentation_layer: Option<String>,
    /// This occurrence's RGBA colour (may differ from the template occurrence's).
    pub color: [f32; 4],
    /// `express_id` of the template `MeshData` this occurrence instantiates — the
    /// consumer's link from record to the geometry it draws (JS-safe u32).
    pub template_express_id: u32,
    /// Representation-identity of the shared geometry (`IfcRepresentationMap` id).
    pub rep_identity: u128,
    /// Row-major, TEMPLATE-RELATIVE mat4: applied to the template's baked world
    /// geometry (`template.origin + positions`) it yields this occurrence's world
    /// geometry (`rel_k = post_rtc(M_k) · post_rtc(M_ref)⁻¹`).
    pub transform: [f32; 16],
}
