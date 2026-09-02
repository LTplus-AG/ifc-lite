// SPDX-License-Identifier: MPL-2.0
//! Domain-format exporters for ifc-lite.
//!
//! Phase 1: **HBJSON** (Honeybee energy-model) room export — the analytic, watertight
//! IFC→Ladybug bridge. Apertures/doors/shades and a glTF migration follow.
//!
//! This is the Rust source of truth; CLI / SDK / wasm become thin callers (mirroring how
//! geometry already flows through `ifc-lite-wasm`).

#[cfg(test)]
#[macro_use]
mod test_support;

mod adjacency;
mod collada;
mod collada_fmt;
mod constructions;
mod csv;
/// The single CSV cell escaper for this crate — RFC 4180 quoting plus the
/// CWE-1236 formula-injection guard, pinned to the TypeScript half by
/// `tests/csv_cell_parity.rs`.
pub mod csv_cell;
mod dfjson;
mod error;
mod frame;
mod geom;
mod gltf;
mod hbjson;
mod ifc5;
mod json;
mod jsonld;
mod kmz;
mod merged;
mod mesh_input;
mod model;
mod obj;
mod relationships;
mod openings;
#[cfg(feature = "parquet-bos")]
mod parquet_bos;
mod rooms;
pub mod rooted_type;
mod schema_convert;
mod schema_detect;
mod schema_pad;
pub use schema_pad::padded_type_universe;
mod shades;
pub mod source_header;
mod step;
mod step_cow;
mod step_header;
mod step_json;
mod step_text;
mod usd;

/// The STEP string-literal escaper; `escape`'s docs say why it is public.
pub use step_text::escape as escape_step_string;

pub use collada::export_collada_from_meshes;
pub use csv::{export_csv, CsvMode, CsvOptions};
pub use dfjson::DfjsonStats;
pub use error::ExportError;
pub use gltf::{
    export_glb, export_glb_from_meshes, export_glb_streaming_bounded,
    export_glb_streaming_bounded_with_index, export_glb_with_stats,
    export_glb_with_stats_with_index, export_gltf_streaming, export_gltf_streaming_with_index,
    project_glb_size, project_glb_size_with_index, try_export_glb, try_export_glb_from_meshes,
    try_export_glb_streaming_bounded, try_export_glb_streaming_bounded_with_index,
    try_export_glb_with_stats, GlbSizeProjection, GltfBuffer, GltfOptions, GltfStats,
};
pub use hbjson::Model;
// Re-exported so a caller can `build_entity_index` once and share it across the
// geometry (`export_glb_with_stats_with_index`) and attribute
// (`stream_export_model_with_index`) passes.
//
// `entity_count` is the cheap `O(scan)`, `O(1)`-memory entity tally (issue
// #1517): a downstream DoS guard can reject a file with a pathological entity
// count WITHOUT forcing the full index (`build_entity_index(..).len()` would
// allocate ~20 B/entity — undoing the bounded-memory work).
pub use ifc_lite_core::{build_entity_index, entity_count, EntityIndex};
// The attribute model, re-exported so a consumer of the row callback can name
// the types it is handed, and `IfcType` so it can tell what it was handed.
pub use ifc_lite_core::{AttributeValue, DecodedEntity, IfcType};
// Re-exported alongside the model so a consumer of `EntityRow` attribute values
// can interpret them: those values are in the file's own units, unlike the
// geometry exporters' output, which is normalised to metres.
pub use ifc_lite_processing::prepass::UnitScales;
// Named so a caller can pick a `GltfOptions::tessellation_quality`.
pub use ifc_lite_processing::TessellationQuality;
pub use ifc5::{export_ifc5, Ifc5Options};
// Spatial and type relationships, which `EntityRow` cannot carry because IFC
// models them as separate entities that are not products.
pub use relationships::{relationships, Relationships};
pub use json::{export_json, JsonOptions};
pub use jsonld::{export_jsonld, JsonLdOptions};
pub use kmz::{
    export_kmz, export_kmz_collada_from_meshes, ifc_angle_to_kml_heading, AltitudeMode, KmzOptions,
};
pub use merged::{
    deterministic_global_id, export_merged, export_merged_models, export_merged_with_stats,
    leading_rooted_global_id, ContainerMergeStrategy, MergedModel, MergedOptions, MergedStats,
    StoreyMergeStrategy, UnitReconciliation,
};
pub use model::{
    build_export_model, build_export_model_with_options, stream_export_model,
    stream_export_model_with_index, stream_export_model_with_options, EntityRow, ExportModel,
    ModelOptions, Placement, PropValue, PropertySet, QuantitySet, QuantityValue,
};
pub use obj::{export_obj, export_obj_with_stats, ObjOptions, ObjStats};
#[cfg(feature = "parquet-bos")]
pub use parquet_bos::{export_bos, ParquetBosOptions};
pub use step::{
    export_step, export_step_to_writer, export_step_with_stats, AttrMutation, CopyOnWriteMutation,
    PropMutation, StepOptions, StepStats,
};
pub use step_json::export_step_json;
pub use usd::{export_usd, UsdOptions};

use ifc_lite_geometry::extract_profiles;

/// Honeybee identifiers may not contain spaces or most special characters; map anything
/// other than alphanumerics / `_` / `-` to `_`.
fn sanitize_identifier(s: &str) -> String {
    let out: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    if out.is_empty() { "model".to_string() } else { out }
}

/// Options for HBJSON export.
pub struct HbjsonOptions {
    /// Model identifier / display name.
    pub name: String,
    /// Geometry tolerance in metres (Honeybee default 0.01).
    pub tolerance: f64,
}

impl Default for HbjsonOptions {
    fn default() -> Self {
        Self { name: "ifc_lite_model".to_string(), tolerance: 0.01 }
    }
}

/// Coverage stats for an HBJSON export.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HbjsonStats {
    /// `IfcSpace` profiles seen in the model.
    pub spaces: usize,
    /// Rooms emitted (watertight prisms).
    pub rooms: usize,
    /// Spaces skipped as degenerate (malformed footprint / holes / non-extrusion — P5).
    pub skipped: usize,
    /// Windows placed as Apertures on exterior wall faces.
    pub apertures: usize,
    /// Doors placed on exterior wall faces.
    pub doors: usize,
    /// Railing / context shade meshes emitted.
    pub shades: usize,
    /// Opaque constructions derived from the IFC material layer sets.
    pub constructions: usize,
    /// Interior faces paired as `Surface` adjacencies (2 per shared wall).
    pub interior_adjacencies: usize,
}

/// Export the `IfcSpace` volumes in `content` (raw IFC/STEP bytes) as an HBJSON string.
///
/// Rooms are built analytically from extruded-area profiles (watertight by construction);
/// faces are typed Floor / RoofCeiling / Wall with outward normals. Returns a Honeybee-valid
/// `Model` JSON ready to load via `honeybee.model.Model.from_hbjson`.
pub fn export_hbjson(content: &[u8], opts: &HbjsonOptions) -> String {
    export_hbjson_with_stats(content, opts).0
}

/// Like [`export_hbjson`] but also returns coverage stats (so callers can report how many
/// spaces were skipped instead of silently truncating).
pub fn export_hbjson_with_stats(content: &[u8], opts: &HbjsonOptions) -> (String, HbjsonStats) {
    let profiles = extract_profiles(content, 0);
    let spaces = profiles.iter().filter(|p| p.ifc_type == "IfcSpace").count();
    let (mut rooms, origin, skipped) = rooms::build_rooms(&profiles, opts.tolerance);
    openings::attach_openings(&profiles, &mut rooms, origin);
    // Pair shared interior walls as Surface adjacencies (drops their exterior openings).
    let interior_adjacencies = adjacency::solve_adjacency(&mut rooms);
    let shade_meshes = shades::build_shades(&profiles, origin);

    // Assign representative opaque constructions (from the IFC material layer sets) by face type.
    let cons = constructions::build_constructions(content, &profiles);
    for room in &mut rooms {
        for f in &mut room.faces {
            let id = match f.face_type {
                "Wall" => cons.wall.clone(),
                "Floor" => cons.floor.clone(),
                "RoofCeiling" => cons.roof.clone(),
                _ => None,
            };
            if let Some(id) = id {
                f.set_construction(id);
            }
        }
    }

    let apertures = rooms.iter().flat_map(|r| &r.faces).map(|f| f.apertures.len()).sum();
    let doors = rooms.iter().flat_map(|r| &r.faces).map(|f| f.doors.len()).sum();
    let shades = shade_meshes.len();
    let n_constructions = cons.energy.as_ref().map_or(0, |e| e.constructions.len());
    let stats = HbjsonStats { spaces, rooms: rooms.len(), skipped, apertures, doors, shades, constructions: n_constructions, interior_adjacencies };

    let model = Model::new(&sanitize_identifier(&opts.name), rooms, shade_meshes, cons.energy, opts.tolerance);
    let json = serde_json::to_string(&model).expect("HBJSON model serializes");
    (json, stats)
}

/// Options for DFJSON (Dragonfly) export.
pub struct DfjsonOptions {
    /// Model identifier / display name.
    pub name: String,
    /// Geometry tolerance in metres (Ladybug Tools default 0.01).
    pub tolerance: f64,
}

impl Default for DfjsonOptions {
    fn default() -> Self {
        Self { name: "ifc_lite_model".to_string(), tolerance: 0.01 }
    }
}

/// Export the `IfcSpace` volumes in `content` (raw IFC/STEP bytes) as a Dragonfly DFJSON
/// string. Each space becomes an extruded `Room2D` (floor polygon + heights) grouped into
/// stories — the simpler Ladybug target for mostly-vertical-wall models.
pub fn export_dfjson(content: &[u8], opts: &DfjsonOptions) -> String {
    export_dfjson_with_stats(content, opts).0
}

/// Like [`export_dfjson`] but also returns coverage stats.
pub fn export_dfjson_with_stats(content: &[u8], opts: &DfjsonOptions) -> (String, DfjsonStats) {
    let profiles = extract_profiles(content, 0);
    // Read the file's own IfcBuilding / IfcBuildingStorey containment so stories are the
    // model's storeys rather than an elevation guess at them (#1911). An empty index
    // (no spatial structure declared) falls back to the elevation heuristic inside
    // `build_model`.
    let spatial = dfjson::spatial_index(content);
    let (model, stats) =
        dfjson::build_model(&sanitize_identifier(&opts.name), &profiles, opts.tolerance, Some(&spatial));
    let json = serde_json::to_string(&model).expect("DFJSON model serializes");
    (json, stats)
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
