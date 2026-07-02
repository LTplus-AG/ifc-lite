// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IFC processing service with parallel geometry extraction.
//!
//! Originally contributed by Mathias Søndergaard (Sonderwoods/Linkajou).

use crate::types::mesh::MeshData;
use crate::types::response::{
    CoordinateInfo, ModelMetadata, ProcessingStats, QuickMetadataBootstrap,
    QuickMetadataEntitySummary,
};
use ifc_lite_core::{
    build_entity_index, DecodedEntity, EntityDecoder,
    EntityIndex, EntityScanner, IfcType,
};
use ifc_lite_geometry::TessellationQuality;
use ifc_lite_geometry::GeometryRouter;
use rayon::prelude::*;
use rustc_hash::{FxHashMap, FxHashSet};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

mod color_layer;
mod opening_filter;
mod properties;
mod quick_metadata;
mod site_local;

pub use site_local::convert_mesh_to_site_local;

use color_layer::{
    collect_presentation_layer_assignments, resolve_element_color_for_product_definition_shape,
    resolve_presentation_layer_for_product_definition_shape,
};
use opening_filter::apply_opening_filter;
use properties::{
    assign_space_zone_properties, collect_property_set_definition,
    collect_rel_defines_by_properties_link, extract_property_name_and_value, PropertySetDefinition,
    RelDefinesByPropertiesLink,
};
use quick_metadata::{
    build_quick_spatial_tree_node, extract_name_from_args, extract_storey_elevation_from_args,
    is_quick_spatial_type_ci, parse_step_arguments, parse_step_ref, parse_step_ref_list,
    QuickSpatialNodeEntry,
};
use site_local::{
    translation_is_nonidentity, MODEL_RTC_MESH_COORDINATE_SPACE, RAW_IFC_MESH_COORDINATE_SPACE,
    SITE_LOCAL_MESH_COORDINATE_SPACE,
};

/// Wall-clock timer for diagnostic `ProcessingStats`. On wasm32
/// `std::time::Instant::now()` traps ("time not implemented on this platform"),
/// so the non-streaming `process_geometry*` entry points (used by the in-browser
/// Rust exporters via `ifc-lite-export`) would panic. Timing is purely diagnostic,
/// so on wasm32 this is a zero-duration no-op; on native it IS `std::time::Instant`
/// (identical behaviour, no overhead).
#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant as Clock;

#[cfg(target_arch = "wasm32")]
#[derive(Clone, Copy)]
struct Clock;

#[cfg(target_arch = "wasm32")]
impl Clock {
    #[inline]
    fn now() -> Self {
        Clock
    }
    #[inline]
    fn elapsed(&self) -> std::time::Duration {
        std::time::Duration::ZERO
    }
}

/// Controls how IfcWindow / IfcDoor openings are exported.
#[derive(Debug, Clone, Copy, PartialEq, Default, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpeningFilterMode {
    /// Export all openings and cut their voids in host walls (default behaviour).
    #[default]
    Default = 0,
    /// Skip all IfcWindow / IfcDoor meshes and do not cut any voids.
    IgnoreAll = 1,
    /// Skip only opaque (non-glazed) windows and doors; glazed ones are kept.
    IgnoreOpaque = 2,
}

impl OpeningFilterMode {
    /// Stable string suffix for disk-cache keys. Unlike `Debug` formatting,
    /// this is guaranteed not to change across compiler versions.
    pub fn cache_key_suffix(&self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::IgnoreAll => "ignore_all",
            Self::IgnoreOpaque => "ignore_opaque",
        }
    }
}

/// Result of processing an IFC file.
pub struct ProcessingResult {
    pub meshes: Vec<MeshData>,
    /// Declares the coordinate space used by serialized mesh vertices.
    pub mesh_coordinate_space: Option<String>,
    /// IfcSite ObjectPlacement as column-major 4x4 matrix (in meters).
    pub site_transform: Option<Vec<f64>>,
    /// IfcBuilding ObjectPlacement as column-major 4x4 matrix (in meters).
    pub building_transform: Option<Vec<f64>>,
    pub metadata: ModelMetadata,
    pub stats: ProcessingStats,
}

/// Controls the tradeoff between first-frame latency and richer upfront metadata.
// Not `Copy`: `entity_index` holds an `Arc`. Every construction either moves the
// struct into a process call once or `..Default::default()`s it, so `Clone` suffices.
#[derive(Debug, Clone)]
pub struct StreamingOptions {
    /// Batch size used for the very first emitted chunk.
    pub initial_batch_size: usize,
    /// Batch size used after the first emitted chunk for higher throughput.
    pub throughput_batch_size: usize,
    /// Prioritize cheap/high-yield element classes first.
    pub fast_first_batch: bool,
    /// Include expensive property parsing on the first-frame path.
    pub include_properties: bool,
    /// Include expensive presentation-layer resolution on the first-frame path.
    pub include_presentation_layers: bool,
    /// Emit a lightweight spatial bootstrap during the scan phase.
    pub emit_quick_metadata_bootstrap: bool,
    /// Retain emitted meshes in the returned ProcessingResult.
    pub retain_emitted_meshes: bool,
    /// Tessellation detail level (#976). `Medium` reproduces the historical
    /// output byte-for-byte; consumer-selectable on the wasm path via
    /// `setTessellationQuality`, and on the server via the
    /// `tessellation_quality` query parameter. 2D symbolic extraction
    /// (`symbolic.rs`) deliberately ignores the level — symbols are
    /// resolution-independent line work.
    pub tessellation_quality: TessellationQuality,
    /// Pre-built entity index to reuse instead of scanning `content` again. A caller
    /// that runs both the geometry pass and a second pass over the same bytes (e.g. a
    /// server emitting GLB *and* extracting properties) can `build_entity_index`
    /// once and inject it here, skipping the duplicate SIMD scan. `None` builds it
    /// internally, exactly as before. The index MUST come from
    /// `build_entity_index(content)` for the *same* `content`, or decoding will read
    /// the wrong byte ranges.
    pub entity_index: Option<Arc<EntityIndex>>,
    /// Cooperative cancellation: when the flag flips true, the streaming core
    /// stops between job chunks (no further meshing or batch emission). The
    /// returned `ProcessingResult` is then PARTIAL - the caller set the flag,
    /// so it must not present the result as a completed parse. Used by the
    /// server to stop burning a core when an SSE client disconnects.
    pub cancel: Option<Arc<std::sync::atomic::AtomicBool>>,
}

impl Default for StreamingOptions {
    fn default() -> Self {
        Self {
            initial_batch_size: 50,
            throughput_batch_size: 50,
            fast_first_batch: false,
            include_properties: true,
            include_presentation_layers: true,
            emit_quick_metadata_bootstrap: false,
            retain_emitted_meshes: true,
            tessellation_quality: TessellationQuality::default(),
            entity_index: None,
            cancel: None,
        }
    }
}

/// Job for processing a single entity.
pub(super) struct EntityJob {
    pub(super) id: u32,
    pub(super) ifc_type: IfcType,
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) product_definition_shape_id: Option<u32>,
    pub(super) element_color: [f32; 4],
    pub(super) global_id: Option<String>,
    pub(super) name: Option<String>,
    pub(super) presentation_layer: Option<String>,
    pub(super) space_zone_properties: Option<BTreeMap<String, String>>,
    /// Set for synthetic type-only-geometry jobs (#957): the `IfcRepresentationMap`
    /// id to render directly (baking its MappingOrigin) instead of walking the
    /// element's `IfcProductDefinitionShape`. `None` for ordinary product jobs.
    pub(super) representation_map_id: Option<u32>,
}

// Only invoked on the wasm32 serial path; dead on the native build.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
// Threads the full metadata-resolution context; splitting it would not improve clarity.
#[allow(clippy::too_many_arguments)]
fn populate_entity_job_metadata(
    job: &mut EntityJob,
    geometry_style_index: &FxHashMap<u32, GeometryStyleInfo>,
    element_material_color: &FxHashMap<u32, [f32; 4]>,
    layer_by_assigned_representation: &FxHashMap<u32, String>,
    color_cache_by_product_definition_shape: &mut FxHashMap<u32, Option<[f32; 4]>>,
    layer_cache_by_product_definition_shape: &mut FxHashMap<u32, Option<String>>,
    layer_cache_by_representation: &mut FxHashMap<u32, Option<String>>,
    decoder: &mut EntityDecoder,
    include_presentation_layers: bool,
) {
    if job.global_id.is_some() || job.name.is_some() || job.product_definition_shape_id.is_some() {
        return;
    }

    let Ok(entity) = decoder.decode_at(job.start, job.end) else {
        return;
    };

    job.global_id = normalize_optional_string(entity.get_string(0));
    job.name = normalize_optional_string(entity.get_string(2));
    job.product_definition_shape_id = entity.get_ref(6);

    let Some(product_definition_shape_id) = job.product_definition_shape_id else {
        return;
    };

    let resolved_color = color_cache_by_product_definition_shape
        .entry(product_definition_shape_id)
        .or_insert_with(|| {
            resolve_element_color_for_product_definition_shape(
                product_definition_shape_id,
                geometry_style_index,
                decoder,
            )
        });
    if let Some(color) = resolved_color {
        job.element_color = *color;
    } else if let Some(color) = element_material_color.get(&job.id) {
        job.element_color = *color;
    }

    if include_presentation_layers {
        let resolved_layer = layer_cache_by_product_definition_shape
            .entry(product_definition_shape_id)
            .or_insert_with(|| {
                resolve_presentation_layer_for_product_definition_shape(
                    product_definition_shape_id,
                    layer_by_assigned_representation,
                    layer_cache_by_representation,
                    decoder,
                )
            });
        job.presentation_layer = resolved_layer.clone();
    }
}

// `GeometryStyleInfo` moved to `crate::style` — it is shared by this
// orchestrator, the canonical per-element producer (`crate::element`), and
// (via `from_color`) the browser batch path.
use crate::style::GeometryStyleInfo;

/// Extract entity references from a list attribute.
pub(crate) fn get_refs_from_list(entity: &DecodedEntity, index: usize) -> Option<Vec<u32>> {
    let list = entity.get_list(index)?;
    let refs: Vec<u32> = list.iter().filter_map(|v| v.as_entity_ref()).collect();
    if refs.is_empty() {
        None
    } else {
        Some(refs)
    }
}

pub(super) fn normalize_optional_string(raw: Option<&str>) -> Option<String> {
    let value = raw?.trim();
    if value.is_empty() || value == "$" {
        return None;
    }
    Some(value.to_string())
}

fn geometry_priority_score(ifc_type: &IfcType) -> u8 {
    match ifc_type {
        IfcType::IfcWall | IfcType::IfcWallStandardCase => 100,
        IfcType::IfcSlab => 95,
        IfcType::IfcColumn => 90,
        IfcType::IfcBeam => 85,
        IfcType::IfcRoof => 80,
        IfcType::IfcStair | IfcType::IfcStairFlight => 75,
        IfcType::IfcCurtainWall => 70,
        IfcType::IfcFooting | IfcType::IfcPile => 65,
        IfcType::IfcDoor | IfcType::IfcWindow => 30,
        IfcType::IfcFurnishingElement => 10,
        _ => 50,
    }
}

/// Process IFC content with parallel geometry extraction (default opening filter).
pub fn process_geometry<T>(content: &T) -> ProcessingResult
where
    T: AsRef<[u8]> + ?Sized,
{
    process_geometry_filtered(content.as_ref(), OpeningFilterMode::Default)
}

/// Like [`process_geometry`] but reuses a pre-built entity index instead of scanning
/// `content` for one. For a caller that also runs a second pass over the same bytes
/// (e.g. pairing GLB export with attribute extraction): build the index once with
/// `ifc_lite_core::build_entity_index` and share it across both, skipping the
/// duplicate scan. `index` MUST be built from the same `content`. Output is identical
/// to `process_geometry(content)`.
pub fn process_geometry_with_index<T>(content: &T, index: Arc<EntityIndex>) -> ProcessingResult
where
    T: AsRef<[u8]> + ?Sized,
{
    process_geometry_streaming_filtered_with_options(
        content.as_ref(),
        OpeningFilterMode::Default,
        StreamingOptions {
            initial_batch_size: usize::MAX,
            throughput_batch_size: usize::MAX,
            entity_index: Some(index),
            ..StreamingOptions::default()
        },
        |_, _, _| {},
        |_| {},
        |_| {},
    )
}

/// Process IFC content with parallel geometry extraction and emit batches as they complete.
pub fn process_geometry_streaming(
    content: &[u8],
    batch_size: usize,
    on_batch: impl FnMut(&[MeshData], usize, usize),
) -> ProcessingResult {
    process_geometry_streaming_with_options(
        content,
        StreamingOptions {
            initial_batch_size: batch_size,
            throughput_batch_size: batch_size,
            ..StreamingOptions::default()
        },
        on_batch,
        |_| {},
    )
}

/// Process IFC content with parallel geometry extraction and configurable streaming behavior.
pub fn process_geometry_streaming_with_options(
    content: &[u8],
    options: StreamingOptions,
    on_batch: impl FnMut(&[MeshData], usize, usize),
    on_color_update: impl FnMut(&[(u32, [f32; 4])]),
) -> ProcessingResult {
    process_geometry_streaming_with_options_and_bootstrap(
        content,
        options,
        on_batch,
        on_color_update,
        |_| {},
    )
}

/// Process IFC content with parallel geometry extraction and emit a quick metadata bootstrap
/// once the scan phase completes.
pub fn process_geometry_streaming_with_options_and_bootstrap(
    content: &[u8],
    options: StreamingOptions,
    on_batch: impl FnMut(&[MeshData], usize, usize),
    on_color_update: impl FnMut(&[(u32, [f32; 4])]),
    on_quick_metadata_bootstrap: impl FnMut(&QuickMetadataBootstrap),
) -> ProcessingResult {
    process_geometry_streaming_filtered_with_options(
        content,
        OpeningFilterMode::Default,
        options,
        on_batch,
        on_color_update,
        on_quick_metadata_bootstrap,
    )
}

/// Process IFC content with parallel geometry extraction and a configurable opening filter.
pub fn process_geometry_filtered<T>(
    content: &T,
    opening_filter: OpeningFilterMode,
) -> ProcessingResult
where
    T: AsRef<[u8]> + ?Sized,
{
    process_geometry_filtered_with_quality(content, opening_filter, TessellationQuality::default())
}

/// Like [`process_geometry_filtered`] with a consumer-selected tessellation
/// detail level (#976) — the server half of the quality knob the wasm path
/// exposes via `setTessellationQuality`.
pub fn process_geometry_filtered_with_quality<T>(
    content: &T,
    opening_filter: OpeningFilterMode,
    tessellation_quality: TessellationQuality,
) -> ProcessingResult
where
    T: AsRef<[u8]> + ?Sized,
{
    let content = content.as_ref();
    process_geometry_streaming_filtered_with_options(
        content,
        opening_filter,
        StreamingOptions {
            initial_batch_size: usize::MAX,
            throughput_batch_size: usize::MAX,
            tessellation_quality,
            ..StreamingOptions::default()
        },
        |_, _, _| {},
        |_| {},
        |_| {},
    )
}

/// Process IFC content with parallel geometry extraction and a configurable streaming batch size.
pub fn process_geometry_streaming_filtered(
    content: &[u8],
    opening_filter: OpeningFilterMode,
    batch_size: usize,
    on_batch: impl FnMut(&[MeshData], usize, usize),
    on_color_update: impl FnMut(&[(u32, [f32; 4])]),
) -> ProcessingResult {
    process_geometry_streaming_filtered_with_options(
        content,
        opening_filter,
        StreamingOptions {
            initial_batch_size: batch_size,
            throughput_batch_size: batch_size,
            ..StreamingOptions::default()
        },
        on_batch,
        on_color_update,
        |_| {},
    )
}

/// Process IFC content with parallel geometry extraction and configurable streaming behavior.
pub fn process_geometry_streaming_filtered_with_options(
    content: &[u8],
    opening_filter: OpeningFilterMode,
    options: StreamingOptions,
    mut on_batch: impl FnMut(&[MeshData], usize, usize),
    mut on_color_update: impl FnMut(&[(u32, [f32; 4])]),
    mut on_quick_metadata_bootstrap: impl FnMut(&QuickMetadataBootstrap),
) -> ProcessingResult {
    let total_start = Clock::now();
    let parse_start = Clock::now();
    let entity_scan_start = Clock::now();

    // Span taxonomy for the pipeline phases. Each phase span mirrors an
    // existing ProcessingStats timer window (instrumentation only, no
    // restructuring); `phase_ms` / count fields are recorded post-hoc from the
    // measurements the pipeline already takes. Field names reuse the
    // GeometryDiagnostics vocabulary (total_csg_failures, backstop_count, ...)
    // so events and the wasm PipelineDiagnostics channel share one vocabulary.
    let pipeline_span = tracing::info_span!(
        "geometry_pipeline",
        byte_size = content.len(),
        element_count = tracing::field::Empty,
        total_ms = tracing::field::Empty,
    );
    let _pipeline_guard = pipeline_span.clone().entered();

    tracing::info!(
        content_size = content.len(),
        "Starting IFC geometry processing"
    );

    let scan_span = tracing::info_span!(
        "scan_prepass",
        total_entities = tracing::field::Empty,
        geometry_entities = tracing::field::Empty,
        phase_ms = tracing::field::Empty,
    );
    let scan_guard = scan_span.clone().entered();

    // Build the entity index (fast SIMD-accelerated single pass), unless a caller
    // injected one built from the same `content` to share across passes.
    let entity_index = tracing::debug_span!("entity_index").in_scope(|| {
        options
            .entity_index
            .clone()
            .unwrap_or_else(|| Arc::new(build_entity_index(content)))
    });
    let mut decoder = EntityDecoder::with_arc_index(content, entity_index.clone());
    tracing::debug!("Built entity index");

    // Styled items / indexed colour maps / material chain / voids / fills /
    // aggregates are span-stashed during the scan and resolved afterwards by
    // the SHARED resolver (`crate::prepass::resolve_prepass`) — the exact code
    // the browser prepasses run, so the #858/#913-class resolution drift
    // cannot recur.
    let mut prepass_spans = crate::prepass::PrepassSpans::default();
    let mut project_id: Option<u32> = None;
    let mut presentation_layer_by_assigned_id: FxHashMap<u32, String> = FxHashMap::default();
    let mut property_values_by_id: FxHashMap<u32, (String, String)> = FxHashMap::default();
    let mut property_sets_by_id: FxHashMap<u32, PropertySetDefinition> = FxHashMap::default();
    let mut rel_defines_by_properties: Vec<RelDefinesByPropertiesLink> = Vec::new();

    // Collect geometry entities
    let mut scanner = EntityScanner::new(content);
    let mut entity_jobs: Vec<EntityJob> = Vec::with_capacity(2000);
    // #957: type-product geometry (IfcXxxType + its RepresentationMaps) and the
    // set of RepresentationMaps already instantiated by an IfcMappedItem. After
    // the scan, RepresentationMaps NOT in the referenced set are rendered as
    // orphan type geometry (buildingSMART annex-E showcase files).
    let mut type_product_geometry: Vec<(u32, usize, usize, IfcType, Vec<u32>)> = Vec::new();
    let mut referenced_representation_maps: FxHashSet<u32> = FxHashSet::default();
    // #957 follow-up: type ids that an IfcRelDefinesByType instantiates (the type
    // has at least one occurrence). Such a type's geometry is already drawn through
    // its occurrences — directly or via an IfcMappedItem — so it must NOT also be
    // rendered as orphan type-only geometry. Real-world exporters (e.g. ArchiCAD
    // AC20) attach a RepresentationMap to nearly every door/window/furniture type
    // while the occurrence carries its own body, leaving the type map referenced by
    // no IfcMappedItem; without this gate every such type double-renders at its
    // MappingOrigin (duplicate boxes at the wrong position).
    let mut instantiated_type_ids: FxHashSet<u32> = FxHashSet::default();
    let quick_metadata_enabled = options.emit_quick_metadata_bootstrap;
    let mut quick_spatial_nodes =
        quick_metadata_enabled.then(HashMap::<u32, QuickSpatialNodeEntry>::new);
    let mut quick_aggregate_links = if quick_metadata_enabled {
        Vec::<(u32, Vec<u32>)>::new()
    } else {
        Vec::new()
    };
    let mut quick_containment_links = if quick_metadata_enabled {
        Vec::<(u32, Vec<u32>)>::new()
    } else {
        Vec::new()
    };
    // IfcRelReferencedInSpatialStructure is a *secondary* (non-owning) link — a
    // space referenced from another storey for context. It must NOT establish
    // primary tree ownership, so it is kept separate from containment links and
    // only ever contributes elements, never parent/child node ownership (#1075).
    let mut quick_referenced_links = if quick_metadata_enabled {
        Vec::<(u32, Vec<u32>)>::new()
    } else {
        Vec::new()
    };
    let mut quick_element_summaries = if quick_metadata_enabled {
        HashMap::<u32, QuickMetadataEntitySummary>::new()
    } else {
        HashMap::new()
    };
    let mut schema_version = "IFC2X3".to_string();
    let mut total_entities = 0usize;
    let mut site_entity_pos: Option<(usize, usize)> = None;
    let mut building_entity_pos: Option<(usize, usize)> = None;

    let defer_style_updates = options.fast_first_batch
        && opening_filter == OpeningFilterMode::Default
        && !options.include_presentation_layers;

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        total_entities += 1;
        if let Some(spatial_nodes) = quick_spatial_nodes.as_mut() {
            // Case-insensitive check without allocating a new uppercase string.
            if is_quick_spatial_type_ci(type_name) {
                let args = parse_step_arguments(&content[start..end]);
                let fallback = format!("{type_name} #{id}");
                spatial_nodes.entry(id).or_insert(QuickSpatialNodeEntry {
                    express_id: id,
                    type_name: type_name.to_string(),
                    name: extract_name_from_args(&args, &fallback),
                    elevation: if type_name.eq_ignore_ascii_case("IfcBuildingStorey") {
                        extract_storey_elevation_from_args(&args)
                    } else {
                        None
                    },
                    children: Vec::new(),
                    elements: Vec::new(),
                    parent: None,
                });
            } else if type_name.eq_ignore_ascii_case("IFCRELAGGREGATES") {
                let args = parse_step_arguments(&content[start..end]);
                if let Some(parent_id) = args.get(4).and_then(|token| parse_step_ref(token)) {
                    quick_aggregate_links.push((
                        parent_id,
                        args.get(5)
                            .map(|token| parse_step_ref_list(token))
                            .unwrap_or_default(),
                    ));
                }
            } else if type_name.eq_ignore_ascii_case("IFCRELCONTAINEDINSPATIALSTRUCTURE") {
                let args = parse_step_arguments(&content[start..end]);
                if let Some(parent_id) = args.get(5).and_then(|token| parse_step_ref(token)) {
                    quick_containment_links.push((
                        parent_id,
                        args.get(4)
                            .map(|token| parse_step_ref_list(token))
                            .unwrap_or_default(),
                    ));
                }
            } else if type_name.eq_ignore_ascii_case("IFCRELREFERENCEDINSPATIALSTRUCTURE") {
                let args = parse_step_arguments(&content[start..end]);
                if let Some(parent_id) = args.get(5).and_then(|token| parse_step_ref(token)) {
                    quick_referenced_links.push((
                        parent_id,
                        args.get(4)
                            .map(|token| parse_step_ref_list(token))
                            .unwrap_or_default(),
                    ));
                }
            }
        }

        if type_name == "IFCINDEXEDCOLOURMAP" {
            // Span-stashed for the shared post-scan resolver (#663, #858).
            prepass_spans.indexed_colour_maps.push((id, start, end));
            continue;
        }

        if type_name == "IFCSTYLEDITEM" {
            // Span-stashed; the shared resolver classifies orphan (material
            // appearance, #407 — always resolved up front) vs
            // geometry-attached (deferred in fast_first_batch mode, #913 §2c).
            prepass_spans.styled_items.push((id, start, end));
            continue;
        } else if type_name == "IFCMATERIALDEFINITIONREPRESENTATION" {
            prepass_spans.material_def_reprs.push((id, start, end));
            continue;
        } else if type_name == "IFCRELASSOCIATESMATERIAL" {
            prepass_spans.rel_associates_material.push((id, start, end));
            continue;
        } else if type_name == "IFCPRESENTATIONLAYERASSIGNMENT" {
            if !options.include_presentation_layers {
                continue;
            }
            if let Ok(layer_assignment) = decoder.decode_at(start, end) {
                collect_presentation_layer_assignments(
                    &mut presentation_layer_by_assigned_id,
                    &layer_assignment,
                );
            }
            continue;
        } else if type_name == "IFCPROPERTYSET" {
            if !options.include_properties {
                continue;
            }
            if let Ok(property_set) = decoder.decode_at(start, end) {
                if let Some(definition) = collect_property_set_definition(&property_set) {
                    property_sets_by_id.insert(id, definition);
                }
            }
            continue;
        } else if type_name == "IFCRELDEFINESBYPROPERTIES" {
            if !options.include_properties {
                continue;
            }
            if let Ok(rel_defines) = decoder.decode_at(start, end) {
                if let Some(link) = collect_rel_defines_by_properties_link(&rel_defines) {
                    rel_defines_by_properties.push(link);
                }
            }
            continue;
        } else if type_name.starts_with("IFCPROPERTY") {
            if !options.include_properties {
                continue;
            }
            if let Ok(property_entity) = decoder.decode_at(start, end) {
                if let Some((name, value)) = extract_property_name_and_value(&property_entity) {
                    property_values_by_id.insert(id, (name, value));
                }
            }
            continue;
        } else if type_name == "IFCRELVOIDSELEMENT" {
            prepass_spans.void_rels.push((id, start, end));
        } else if type_name == "IFCRELFILLSELEMENT" {
            prepass_spans.fills_rels.push((id, start, end));
        } else if type_name == "IFCRELAGGREGATES" {
            // Independent of quick-metadata mode: the shared resolver decodes
            // these into the parent → children map that pushes voids down to
            // aggregated parts when the host has no body of its own
            // (IfcWallElementedCase, #845).
            prepass_spans.aggregate_rels.push((id, start, end));
        } else if type_name == "IFCPROJECT" && project_id.is_none() {
            project_id = Some(id);
        } else if type_name == "IFCSITE" && site_entity_pos.is_none() {
            site_entity_pos = Some((start, end));
        } else if type_name == "IFCBUILDING" && building_entity_pos.is_none() {
            building_entity_pos = Some((start, end));
        }

        if ifc_lite_core::has_geometry_by_name(type_name) {
            // Legacy-aware so a remapped entity (IfcProxy, IfcSolidStratum, …)
            // labels its node with the real base type, not "Unknown", and matches
            // the attribute pass's row type (#1496).
            let ifc_type = ifc_lite_core::legacy_aware_ifc_type(type_name);
            if quick_metadata_enabled {
                quick_element_summaries.insert(
                    id,
                    QuickMetadataEntitySummary {
                        express_id: id,
                        type_name: type_name.to_string(),
                        name: format!("{type_name} #{id}"),
                        global_id: None,
                        kind: "element".to_string(),
                        has_children: false,
                        element_count: None,
                        elevation: None,
                    },
                );
            }
            entity_jobs.push(EntityJob {
                id,
                ifc_type,
                start,
                end,
                product_definition_shape_id: None,
                element_color: crate::style::default_color_for_type(ifc_type).to_array(),
                global_id: None,
                name: None,
                presentation_layer: None,
                space_zone_properties: None,
                representation_map_id: None,
            });
        }
        // #957: collect type-product geometry (IfcXxxType carrying its own
        // RepresentationMaps) and every IfcMappedItem's MappingSource, so after
        // the scan we can render the RepresentationMaps that NO occurrence
        // instantiates (orphan library/showcase geometry). The cheap suffix
        // pre-filter keeps the is_subtype_of check off the hot path for the
        // ~all-non-type majority of entities.
        else if type_name == "IFCMAPPEDITEM" {
            let args = parse_step_arguments(&content[start..end]);
            if let Some(source_id) = args.first().and_then(|token| parse_step_ref(token)) {
                referenced_representation_maps.insert(source_id);
            }
        } else if type_name == "IFCRELDEFINESBYTYPE" {
            // IfcRelDefinesByType.RelatingType is the last attribute (index 5);
            // record it so its type-only geometry is suppressed (it has occurrences).
            let args = parse_step_arguments(&content[start..end]);
            if let Some(type_id) = args.get(5).and_then(|token| parse_step_ref(token)) {
                instantiated_type_ids.insert(type_id);
            }
        } else if (type_name.ends_with("TYPE") || type_name.ends_with("STYLE"))
            && IfcType::from_str(type_name).is_subtype_of(IfcType::IfcTypeProduct)
        {
            let args = parse_step_arguments(&content[start..end]);
            // IfcTypeProduct.RepresentationMaps is attribute index 6.
            let rep_map_ids = args
                .get(6)
                .map(|token| parse_step_ref_list(token))
                .unwrap_or_default();
            if !rep_map_ids.is_empty() {
                type_product_geometry.push((
                    id,
                    start,
                    end,
                    IfcType::from_str(type_name),
                    rep_map_ids,
                ));
            }
        }
    }

    // #957: synthesize render jobs for orphan type-product geometry — a
    // RepresentationMap on an IfcXxxType that no IfcMappedItem instantiates.
    // Normally-instanced typed products keep their geometry on the occurrence
    // (whose IfcMappedItem references the map), so those maps are in
    // `referenced_representation_maps` and skipped here — no double render.
    // buildingSMART annex-E "tessellated shape with style" files declare the
    // geometry only on the type, so without this they render nothing (#957).
    for (type_id, start, end, ifc_type, rep_map_ids) in &type_product_geometry {
        // The orphan/instanced decision is canonical in
        // `element::plan_type_geometry`; the native pipeline suppresses
        // instanced types entirely (an export must never duplicate geometry),
        // so every planned map here renders as an orphan (class 1).
        for (rep_map_id, _class) in crate::element::plan_type_geometry(
            rep_map_ids,
            &referenced_representation_maps,
            instantiated_type_ids.contains(type_id),
            crate::element::TypeGeometryMode::SuppressInstanced,
        ) {
            entity_jobs.push(EntityJob {
                id: *type_id,
                ifc_type: *ifc_type,
                start: *start,
                end: *end,
                product_definition_shape_id: None,
                element_color: crate::style::default_color_for_type(*ifc_type).to_array(),
                global_id: None,
                name: None,
                presentation_layer: None,
                space_zone_properties: None,
                representation_map_id: Some(rep_map_id),
            });
        }
    }

    // ── Shared post-scan resolution (`crate::prepass`) ──
    // Styled items (orphan vs attached, defer-aware), IfcIndexedColourMap,
    // the #407 material chain join, voids + fills, and the #845 aggregate
    // void propagation — the exact code the browser prepasses run.
    let resolved = crate::prepass::resolve_prepass(
        &prepass_spans,
        &mut decoder,
        crate::prepass::ResolveOptions {
            collect_indexed_colour_full: true,
            defer_attached_styles: defer_style_updates,
        },
    );
    let crate::prepass::ResolvedPrepass {
        mut geometry_style_index,
        indexed_colour_index,
        indexed_colour_full,
        element_material_colors,
        void_index,
        filling_by_opening,
        deferred_attached_styled_spans: deferred_styled_item_positions,
        ..
    } = resolved;

    let entity_scan_time = entity_scan_start.elapsed();
    scan_span.record("total_entities", total_entities as u64);
    scan_span.record("geometry_entities", entity_jobs.len() as u64);
    scan_span.record("phase_ms", entity_scan_time.as_millis() as u64);
    drop(scan_guard);

    let lookup_start = Clock::now();
    let lookup_span = tracing::debug_span!("lookup", phase_ms = tracing::field::Empty).entered();
    if options.include_properties {
        assign_space_zone_properties(
            &mut entity_jobs,
            &property_values_by_id,
            &property_sets_by_id,
            &rel_defines_by_properties,
        );
    }
    if options.fast_first_batch {
        entity_jobs.sort_by(|left, right| {
            geometry_priority_score(&right.ifc_type).cmp(&geometry_priority_score(&left.ifc_type))
        });
    }
    let lookup_time = lookup_start.elapsed();
    lookup_span.record("phase_ms", lookup_time.as_millis() as u64);
    drop(lookup_span);

    let (skipped_entity_ids, filtered_void_index) = apply_opening_filter(
        &entity_jobs,
        &void_index,
        &filling_by_opening,
        &geometry_style_index,
        &mut decoder,
        opening_filter,
    );

    // Detect schema version
    if content
        .windows(b"IFC4X3".len())
        .any(|window| window == b"IFC4X3")
    {
        schema_version = "IFC4X3".into();
    } else if content
        .windows(b"IFC4".len())
        .any(|window| window == b"IFC4")
    {
        schema_version = "IFC4".into();
    }

    let geometry_entity_count = entity_jobs.len();
    tracing::info!(
        total_entities = total_entities,
        geometry_entities = geometry_entity_count,
        voids = void_index.len(),
        schema_version = %schema_version,
        "Entity scanning complete"
    );

    if let Some(mut spatial_nodes) = quick_spatial_nodes.take() {
        for (parent_id, child_ids) in quick_aggregate_links {
            if !spatial_nodes.contains_key(&parent_id) {
                continue;
            }
            for child_id in child_ids {
                if !spatial_nodes.contains_key(&child_id) {
                    continue;
                }
                if let Some(parent) = spatial_nodes.get_mut(&parent_id) {
                    parent.children.push(child_id);
                }
                if let Some(child) = spatial_nodes.get_mut(&child_id) {
                    child.parent = Some(parent_id);
                }
            }
        }
        for (parent_id, element_ids) in quick_containment_links {
            if !spatial_nodes.contains_key(&parent_id) {
                continue;
            }
            for child_id in element_ids {
                // A spatial element (IfcSpace / IfcSpatialZone) attached to a
                // storey via IfcRelContainedInSpatialStructure — what Revit
                // Family + Dynamo emits instead of IfcRelAggregates — is a real
                // node of the spatial tree, not a contained product. Promote it
                // to a child node so it shows in the hierarchy (#1075); anything
                // that isn't itself a spatial node stays a contained element.
                if spatial_nodes.contains_key(&child_id) {
                    // Skip if already placed via IfcRelAggregates (wired just
                    // above) to avoid a duplicate child / parent overwrite.
                    let already_placed = spatial_nodes
                        .get(&child_id)
                        .is_some_and(|child| child.parent.is_some());
                    if !already_placed {
                        if let Some(parent) = spatial_nodes.get_mut(&parent_id) {
                            parent.children.push(child_id);
                        }
                        if let Some(child) = spatial_nodes.get_mut(&child_id) {
                            child.parent = Some(parent_id);
                        }
                    }
                } else if let Some(parent) = spatial_nodes.get_mut(&parent_id) {
                    parent.elements.push(child_id);
                }
            }
        }
        // Referenced-in links are non-owning: they only contribute elements and
        // never promote to (or re-parent) a spatial node, so a space referenced
        // from a second storey can't steal ownership from its containing storey.
        for (parent_id, element_ids) in quick_referenced_links {
            if !spatial_nodes.contains_key(&parent_id) {
                continue;
            }
            for child_id in element_ids {
                // A child that is itself a spatial node keeps the ownership it
                // got from its IfcRelContainedInSpatialStructure/aggregate link.
                if spatial_nodes.contains_key(&child_id) {
                    continue;
                }
                if let Some(parent) = spatial_nodes.get_mut(&parent_id) {
                    parent.elements.push(child_id);
                }
            }
        }
        let mut root_id = spatial_nodes
            .values()
            .find(|node| node.type_name == "IfcProject")
            .map(|node| node.express_id);
        if root_id.is_none() {
            root_id = spatial_nodes
                .values()
                .find(|node| node.parent.is_none())
                .map(|node| node.express_id);
        }
        let spatial_tree = root_id
            .map(|root| {
                build_quick_spatial_tree_node(root, &spatial_nodes, &quick_element_summaries)
            })
            .transpose()
            .unwrap_or(None);
        on_quick_metadata_bootstrap(&QuickMetadataBootstrap {
            schema_version: schema_version.clone(),
            entity_count: total_entities,
            spatial_tree,
        });
    }

    // Preprocess complex geometry
    let preprocess_start = Clock::now();
    let preprocess_span =
        tracing::debug_span!("preprocess", phase_ms = tracing::field::Empty).entered();
    // Resolve BOTH unit scales once via the shared resolver (the scan recorded
    // IFCPROJECT's id, so this is an O(1) decode — no more full-file hunts:
    // the historic `with_units` + `plane_angle_to_radians` pair each re-walked
    // the whole DATA section). Seed the shared decoder so every later consumer
    // (opening filter, metadata phase, deferred-style replay) inherits them.
    let unit_scales = tracing::debug_span!("unit_scale")
        .in_scope(|| crate::prepass::resolve_unit_scales(content, project_id, &mut decoder));
    tracing::debug!(
        length_unit_scale = unit_scales.length_unit_scale,
        plane_angle_to_radians = unit_scales.plane_angle_to_radians,
        "Resolved unit scales"
    );
    decoder.seed_unit_scales(
        unit_scales.length_unit_scale,
        unit_scales.plane_angle_to_radians,
    );
    let mut router = GeometryRouter::with_scale(unit_scales.length_unit_scale);
    router.set_tessellation_quality(options.tessellation_quality);
    // Slice single-solid walls/slabs with an IfcMaterialLayerSetUsage into one
    // coloured sub-mesh per layer (#563); #874 dropped this wiring across every
    // pipeline. The native pass processes the file once, so build the index
    // directly here (the wasm batch path caches it on the IfcAPI). Cheap on
    // files with no layer set (substring bail-out inside the builder).
    router.set_material_layer_index(Arc::new(
        ifc_lite_geometry::MaterialLayerIndex::from_content(content, &mut decoder),
    ));

    // Resolve IfcSite and IfcBuilding placement transforms.
    let site_transform: Option<Vec<f64>> = site_entity_pos.and_then(|(start, end)| {
        let entity = decoder.decode_at(start, end).ok()?;
        let matrix = router
            .resolve_scaled_placement(&entity, &mut decoder)
            .ok()?;
        Some(matrix.to_vec())
    });
    let building_transform: Option<Vec<f64>> = building_entity_pos.and_then(|(start, end)| {
        let entity = decoder.decode_at(start, end).ok()?;
        let matrix = router
            .resolve_scaled_placement(&entity, &mut decoder)
            .ok()?;
        Some(matrix.to_vec())
    });

    let rtc_jobs: Vec<(u32, usize, usize, IfcType)> = entity_jobs
        .iter()
        .map(|job| (job.id, job.start, job.end, job.ifc_type))
        .collect();
    let detected_rtc_offset =
        router.detect_rtc_offset_with_fallback(&rtc_jobs, &mut decoder, content);

    // Three-tier coordinate-space selection:
    //   1. `site_local`: IfcSite placement has a non-identity translation.
    //      Vertices are expressed relative to the site origin — small floats
    //      AND a meaningful, relatable frame (useful for coordination).
    //   2. `model_rtc`:  IfcSite is identity (or missing) but geometry still
    //      lives at large world coordinates. Subtract a detected anchor so
    //      f32 precision is preserved.
    //   3. `raw_ifc`:    neither anchor applies; geometry is already small.
    let site_rtc = site_transform
        .as_ref()
        .map(|st| (st[12], st[13], st[14])) // column-major: translation at 12,13,14
        .filter(|t| translation_is_nonidentity(*t));
    let detected_has_offset = translation_is_nonidentity(detected_rtc_offset);
    let (rtc_offset, coord_space) = if let Some(site) = site_rtc {
        (site, SITE_LOCAL_MESH_COORDINATE_SPACE)
    } else if detected_has_offset {
        (detected_rtc_offset, MODEL_RTC_MESH_COORDINATE_SPACE)
    } else {
        ((0.0, 0.0, 0.0), RAW_IFC_MESH_COORDINATE_SPACE)
    };
    let has_rtc_offset = coord_space != RAW_IFC_MESH_COORDINATE_SPACE;
    router.set_rtc_offset(rtc_offset);
    let preprocess_time = preprocess_start.elapsed();
    preprocess_span.record("phase_ms", preprocess_time.as_millis() as u64);
    drop(preprocess_span);

    let parse_time = parse_start.elapsed();
    tracing::info!(
        entity_scan_time_ms = entity_scan_time.as_millis(),
        lookup_time_ms = lookup_time.as_millis(),
        preprocess_time_ms = preprocess_time.as_millis(),
        parse_time_ms = parse_time.as_millis(),
        "Parse phase complete, starting geometry extraction"
    );

    // PARALLEL GEOMETRY PROCESSING
    let geometry_start = Clock::now();
    let entity_index_arc = entity_index; // Already Arc from above
    let unit_scale = router.unit_scale();
    let rtc_offset = router.rtc_offset();
    // Resolve the plane-angle scale ONCE on the warm shared decoder, then seed
    // every per-element worker decoder below (EntityDecoder::seed_unit_scales).
    // Resolved once by the shared `prepass::resolve_unit_scales` above — the
    // parallel path builds a fresh (cold-cache) decoder per element, so
    // without seeding every arc-bearing element would re-pay an O(file)
    // IFCPROJECT scan (≈135 ms each on a 75 MB model where IFCPROJECT sits at
    // byte ~68 MB).
    let seed_plane_angle_to_radians = unit_scales.plane_angle_to_radians;
    let void_index_arc = Arc::new(filtered_void_index);
    let skipped_entity_ids = Arc::new(skipped_entity_ids);
    // Fold indexed-colour-map colours in where no IFCSTYLEDITEM already claimed
    // the geometry (styled items win, matching the browser precedence).
    crate::prepass::merge_indexed_colours(&mut geometry_style_index, &indexed_colour_index);
    let mut geometry_style_index = Arc::new(geometry_style_index);
    let indexed_colour_full = Arc::new(indexed_colour_full);
    // #961: decode surface textures (IfcBlobTexture PNG / IfcPixelTexture) and
    // their per-triangle UV maps once, keyed by face-set id. `build_texture_index`
    // bails out on a cheap substring check for the (vast majority) untextured
    // files. Consumed by the type-only render path below.
    let texture_index = Arc::new(ifc_lite_geometry::build_texture_index(
        content,
        &mut decoder,
    ));
    // Material chain joined by the shared resolver (#407). The single
    // opaque-first colour is the general-path element fallback; the full list
    // feeds the opening sub-mesh transparent/opaque split (#913 §2.3).
    let element_material_color: FxHashMap<u32, [f32; 4]> = element_material_colors
        .iter()
        .filter_map(|(&id, colors)| crate::style::pick_opaque_first(colors).map(|c| (id, c)))
        .collect();
    let element_material_colors = Arc::new(element_material_colors);

    let total_jobs = entity_jobs.len();
    let initial_chunk_size = options.initial_batch_size.max(1);
    let throughput_chunk_size = options.throughput_batch_size.max(initial_chunk_size);
    let mut color_cache_by_product_definition_shape: FxHashMap<u32, Option<[f32; 4]>> =
        FxHashMap::default();
    let mut layer_cache_by_product_definition_shape: FxHashMap<u32, Option<String>> =
        FxHashMap::default();
    let mut layer_cache_by_representation: FxHashMap<u32, Option<String>> = FxHashMap::default();
    let mut meshes: Vec<MeshData> = Vec::new();
    let mut processed_jobs = 0usize;
    let mut total_meshes = 0usize;
    let mut total_vertices = 0usize;
    let mut total_triangles = 0usize;
    let mut chunk_start = 0usize;
    let mut current_chunk_size = initial_chunk_size;

    let mut deferred_styles_applied = !defer_style_updates;

    // CSG-diagnostics sink shared across all per-job routers (drained after
    // the loop into ProcessingStats + one tracing summary).
    let csg_failure_collector: std::sync::Mutex<FxHashMap<u32, Vec<ifc_lite_geometry::BoolFailure>>> =
        std::sync::Mutex::new(FxHashMap::default());
    // Opening-classification + per-host opening diagnostics sinks, drained from
    // each fresh per-job router and merged here, so the native pass can build the
    // SAME `GeometryDiagnostics` the WASM batch path produces. Drained from the
    // local router (not inside `produce_element_meshes`) because the WASM batch path
    // shares that function and drains classification/host from its own warm router
    // at batch end — draining there would empty it.
    let classification_collector: std::sync::Mutex<ifc_lite_geometry::ClassificationStats> =
        std::sync::Mutex::new(ifc_lite_geometry::ClassificationStats::default());
    let host_diag_collector: std::sync::Mutex<FxHashMap<u32, ifc_lite_geometry::HostOpeningDiagnostic>> =
        std::sync::Mutex::new(FxHashMap::default());
    // rect_fast engagement is now drained from each per-job router too (request-
    // local), so this pass's `rectFast` is isolated from any concurrent geometry
    // pass instead of reading process-global counters.
    let rect_fast_collector: std::sync::Mutex<ifc_lite_geometry::RectFastStats> =
        std::sync::Mutex::new(ifc_lite_geometry::RectFastStats::default());
    // Degenerate-backstop drop tally, summed from each element's
    // `ProducedElementMeshes::degenerate_triangles_dropped` (request-local,
    // like the other sinks). Non-zero means the f32-collapse safety net in
    // `element::build_mesh_data` engaged for this model.
    let backstop_collector = std::sync::atomic::AtomicU64::new(0);

    // Shared content-dedup cache for the whole model: every per-job router (built
    // fresh per element below) dedups against it, so byte-identical geometry the
    // exporter failed to share via IfcMappedItem (Tekla parts) is meshed once
    // across the rayon pool instead of once per element. The lock is held only for
    // a hash get/insert; meshing runs outside it.
    let item_dedup_cache = GeometryRouter::new_dedup_cache();

    let geometry_span = tracing::info_span!(
        "geometry",
        element_count = total_jobs,
        mesh_count = tracing::field::Empty,
        triangle_count = tracing::field::Empty,
        backstop_count = tracing::field::Empty,
        total_csg_failures = tracing::field::Empty,
        phase_ms = tracing::field::Empty,
    );
    let geometry_guard = geometry_span.clone().entered();

    while chunk_start < total_jobs {
        // Cooperative cancellation between chunks: the caller flipped the flag
        // (e.g. its client disconnected), so stop meshing and emitting. The
        // result below is partial by contract; see StreamingOptions::cancel.
        if options
            .cancel
            .as_ref()
            .is_some_and(|c| c.load(std::sync::atomic::Ordering::Relaxed))
        {
            break;
        }
        let chunk_end = (chunk_start + current_chunk_size).min(total_jobs);
        let jobs_chunk = &mut entity_jobs[chunk_start..chunk_end];

        // ── Desktop: two-phase parallel metadata population ──
        // Phase 1 (parallel): decode entities, extract GlobalId/Name/ProductDefinitionShapeId
        // Phase 2 (serial): resolve colors from cache (cheap, cache-hit dominated)
        #[cfg(not(target_arch = "wasm32"))]
        {
            // Phase 1: parallel decode with thread-local EntityDecoder
            let entity_index_for_meta = entity_index_arc.clone();
            jobs_chunk.par_iter_mut().for_each(|job| {
                if job.global_id.is_some()
                    || job.name.is_some()
                    || job.product_definition_shape_id.is_some()
                {
                    return;
                }
                let mut local_decoder =
                    EntityDecoder::with_arc_index(content, entity_index_for_meta.clone());
                let Ok(entity) = local_decoder.decode_at(job.start, job.end) else {
                    return;
                };
                job.global_id = normalize_optional_string(entity.get_string(0));
                job.name = normalize_optional_string(entity.get_string(2));
                job.product_definition_shape_id = entity.get_ref(6);
            });

            // Phase 2: serial color/layer resolution (cache-hit dominated, fast)
            for job in jobs_chunk.iter_mut() {
                let Some(pds_id) = job.product_definition_shape_id else {
                    continue;
                };
                let resolved_color = color_cache_by_product_definition_shape
                    .entry(pds_id)
                    .or_insert_with(|| {
                        resolve_element_color_for_product_definition_shape(
                            pds_id,
                            &geometry_style_index,
                            &mut decoder,
                        )
                    });
                if let Some(color) = resolved_color {
                    job.element_color = *color;
                } else if let Some(color) = element_material_color.get(&job.id) {
                    // No direct/indexed geometry style — inherit the material
                    // appearance (#407).
                    job.element_color = *color;
                }
                if options.include_presentation_layers {
                    let resolved_layer = layer_cache_by_product_definition_shape
                        .entry(pds_id)
                        .or_insert_with(|| {
                            resolve_presentation_layer_for_product_definition_shape(
                                pds_id,
                                &presentation_layer_by_assigned_id,
                                &mut layer_cache_by_representation,
                                &mut decoder,
                            )
                        });
                    job.presentation_layer = resolved_layer.clone();
                }
            }
        }

        // ── WASM: existing serial path (unchanged) ──
        #[cfg(target_arch = "wasm32")]
        for job in jobs_chunk.iter_mut() {
            populate_entity_job_metadata(
                job,
                &geometry_style_index,
                &element_material_color,
                &presentation_layer_by_assigned_id,
                &mut color_cache_by_product_definition_shape,
                &mut layer_cache_by_product_definition_shape,
                &mut layer_cache_by_representation,
                &mut decoder,
                options.include_presentation_layers,
            );
        }
        let site_local_rotation: Option<&Vec<f64>> =
            if coord_space == SITE_LOCAL_MESH_COORDINATE_SPACE {
                site_transform.as_ref()
            } else {
                None
            };
        let chunk_meshes: Vec<MeshData> = jobs_chunk
            .par_iter()
            .flat_map_iter(|job| {
                process_entity_job(
                    job,
                    content,
                    &entity_index_arc,
                    unit_scale,
                    rtc_offset,
                    seed_plane_angle_to_radians,
                    options.tessellation_quality,
                    void_index_arc.as_ref(),
                    skipped_entity_ids.as_ref(),
                    geometry_style_index.as_ref(),
                    indexed_colour_full.as_ref(),
                    element_material_colors.as_ref(),
                    texture_index.as_ref(),
                    site_local_rotation,
                    &csg_failure_collector,
                    &classification_collector,
                    &host_diag_collector,
                    &rect_fast_collector,
                    &backstop_collector,
                    &item_dedup_cache,
                )
            })
            .collect();

        processed_jobs += jobs_chunk.len();
        total_vertices += chunk_meshes.iter().map(|m| m.vertex_count()).sum::<usize>();
        total_triangles += chunk_meshes
            .iter()
            .map(|m| m.triangle_count())
            .sum::<usize>();

        if !chunk_meshes.is_empty() {
            total_meshes += chunk_meshes.len();
            let emit_mesh_chunk_size = current_chunk_size.max(1);
            for emitted_meshes in chunk_meshes.chunks(emit_mesh_chunk_size) {
                on_batch(emitted_meshes, processed_jobs, total_jobs);
            }
            if options.retain_emitted_meshes {
                meshes.extend(chunk_meshes);
            }

            if !deferred_styles_applied {
                // Replay saved IFCSTYLEDITEM positions instead of re-scanning
                // the entire file.  This eliminates ~0.5-1 s for 1 GB files.
                // The replay is the shared resolver's styled-item building
                // block, so deferred and up-front resolution cannot drift.
                let mut rebuilt_styles = {
                    let mut style_decoder =
                        EntityDecoder::with_arc_index(content, entity_index_arc.clone());
                    crate::prepass::resolve_styled_item_spans(
                        &deferred_styled_item_positions,
                        &mut style_decoder,
                    )
                };
                crate::prepass::merge_indexed_colours(&mut rebuilt_styles, &indexed_colour_index);
                geometry_style_index = Arc::new(rebuilt_styles);
                let deferred_color_updates = build_color_updates_for_jobs(
                    &entity_jobs[..processed_jobs],
                    geometry_style_index.as_ref(),
                    content,
                    &entity_index_arc,
                );
                if !deferred_color_updates.is_empty() {
                    on_color_update(&deferred_color_updates);
                }
                deferred_styles_applied = true;
            }
        }
        chunk_start = chunk_end;
        current_chunk_size = throughput_chunk_size;
    }

    let geometry_time = geometry_start.elapsed();
    // Surface the aggregated CSG diagnostics — same per-reason breakdown the
    // browser console shows on the wasm path.
    let csg_failures = csg_failure_collector
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let total_csg_failures: usize = csg_failures.values().map(Vec::len).sum();
    let products_with_failures = csg_failures.len();
    let backstop_dropped = backstop_collector.into_inner();
    geometry_span.record("mesh_count", total_meshes as u64);
    geometry_span.record("triangle_count", total_triangles as u64);
    geometry_span.record("backstop_count", backstop_dropped);
    geometry_span.record("total_csg_failures", total_csg_failures as u64);
    geometry_span.record("phase_ms", geometry_time.as_millis() as u64);
    drop(geometry_guard);
    if total_csg_failures > 0 {
        let mut by_reason: HashMap<&'static str, usize> = HashMap::new();
        for fails in csg_failures.values() {
            for f in fails {
                *by_reason.entry(f.reason.label()).or_insert(0) += 1;
            }
        }
        let mut breakdown: Vec<(&'static str, usize)> = by_reason.into_iter().collect();
        breakdown.sort_by(|a, b| b.1.cmp(&a.1));
        let breakdown = breakdown
            .iter()
            .map(|(reason, count)| format!("{reason}={count}"))
            .collect::<Vec<_>>()
            .join(" ");
        tracing::warn!(
            total_csg_failures,
            products_with_failures,
            %breakdown,
            "CSG failures during geometry extraction (cut dropped, host kept uncut)"
        );
    }

    // Build the full GeometryDiagnostics contract from the drained sinks — the
    // SAME shape the wasm batch path surfaces, so a native consumer and a browser
    // consumer see identical diagnostics. `None` when nothing diagnostic-worthy
    // happened (mirrors the wasm `is_empty` skip).
    //
    // Every sink — `classification`, `host_diags`, `csg_failures` AND `rect_fast` —
    // is request-local: each was drained from this pass's own per-job routers and
    // merged here, so concurrent in-process geometry passes never cross-contaminate.
    let geometry_diagnostics = tracing::debug_span!("collate_diagnostics").in_scope(|| {
        // Matches the wasm path's WORST_HOSTS_LIMIT (top-N per-host detail cap).
        const WORST_HOSTS_LIMIT: usize = 16;
        let classification = classification_collector
            .into_inner()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let host_diags = host_diag_collector
            .into_inner()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let rect_fast = rect_fast_collector
            .into_inner()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let diag = ifc_lite_geometry::aggregate_diagnostics(
            classification,
            &csg_failures,
            &host_diags,
            rect_fast,
            WORST_HOSTS_LIMIT,
        );
        (!diag.is_empty()).then_some(diag)
    });

    let total_time = total_start.elapsed();
    pipeline_span.record("element_count", total_jobs as u64);
    pipeline_span.record("total_ms", total_time.as_millis() as u64);

    tracing::info!(
        meshes = meshes.len(),
        vertices = total_vertices,
        triangles = total_triangles,
        backstop_count = backstop_dropped,
        geometry_time_ms = geometry_time.as_millis(),
        total_time_ms = total_time.as_millis(),
        "Geometry processing complete"
    );

    ProcessingResult {
        meshes,
        mesh_coordinate_space: Some(coord_space.to_string()),
        site_transform,
        building_transform,
        metadata: ModelMetadata {
            schema_version,
            entity_count: total_entities,
            geometry_entity_count,
            coordinate_info: CoordinateInfo {
                origin_shift: [rtc_offset.0, rtc_offset.1, rtc_offset.2],
                is_geo_referenced: has_rtc_offset,
            },
            length_unit_scale: Some(unit_scale),
            georeferencing: crate::extract_georeferencing(content),
        },
        stats: ProcessingStats {
            total_meshes,
            total_vertices,
            total_triangles,
            parse_time_ms: parse_time.as_millis() as u64,
            entity_scan_time_ms: entity_scan_time.as_millis() as u64,
            lookup_time_ms: lookup_time.as_millis() as u64,
            preprocess_time_ms: preprocess_time.as_millis() as u64,
            geometry_time_ms: geometry_time.as_millis() as u64,
            total_time_ms: total_time.as_millis() as u64,
            from_cache: false,
            total_csg_failures: total_csg_failures as u64,
            products_with_failures: products_with_failures as u64,
            degenerate_triangles_dropped: backstop_dropped,
            geometry_diagnostics,
        },
    }
}

// Carries the full per-job processing context; factoring the args into a struct
// would not change behavior and is out of scope for the lint gate.
#[allow(clippy::too_many_arguments)]
fn process_entity_job(
    job: &EntityJob,
    content: &[u8],
    entity_index_arc: &Arc<EntityIndex>,
    unit_scale: f64,
    rtc_offset: (f64, f64, f64),
    // Pre-resolved scales seeded into this job's decoder so arc tessellation and
    // unit conversion never trigger a per-element full-file IFCPROJECT scan.
    seed_plane_angle_to_radians: f64,
    tessellation_quality: TessellationQuality,
    void_index: &FxHashMap<u32, Vec<u32>>,
    skipped_entity_ids: &HashSet<u32>,
    geometry_style_index: &FxHashMap<u32, GeometryStyleInfo>,
    indexed_colour_full: &FxHashMap<u32, crate::style::FullIndexedColourMap>,
    element_material_colors: &FxHashMap<u32, Vec<[f32; 4]>>,
    // Surface textures + UV maps keyed by face-set id (#961). Empty for
    // untextured models.
    texture_index: &FxHashMap<u32, ifc_lite_geometry::ResolvedTextureMap>,
    // Present only when the selected coordinate space is `site_local`; rotates
    // mesh vertices into the site's axis frame.
    site_local_rotation: Option<&Vec<f64>>,
    // Shared sink for per-job router CSG diagnostics (parity with the wasm
    // path's `drain_and_log_csg_diagnostics`).
    csg_failure_collector: &std::sync::Mutex<FxHashMap<u32, Vec<ifc_lite_geometry::BoolFailure>>>,
    // Shared sinks for opening classification + per-host opening diagnostics, drained
    // from this job's router so the native pass aggregates the full GeometryDiagnostics.
    classification_collector: &std::sync::Mutex<ifc_lite_geometry::ClassificationStats>,
    host_diag_collector: &std::sync::Mutex<FxHashMap<u32, ifc_lite_geometry::HostOpeningDiagnostic>>,
    rect_fast_collector: &std::sync::Mutex<ifc_lite_geometry::RectFastStats>,
    // Shared tally of degenerate-backstop triangle drops (see
    // `element::build_mesh_data`); relaxed atomic, added to only when non-zero.
    backstop_collector: &std::sync::atomic::AtomicU64,
    // Model-wide content-dedup cache shared by every per-job router so identical
    // geometry is meshed once across the rayon pool (#1109 follow-up).
    item_dedup_cache: &ifc_lite_geometry::ItemDedupCache,
) -> Vec<MeshData> {
    if skipped_entity_ids.contains(&job.id) {
        return Vec::new();
    }

    let mut local_decoder = EntityDecoder::with_arc_index(content, entity_index_arc.clone());
    // Seed the unit-scale caches so curve/arc processing skips the O(file)
    // IFCPROJECT scan that each fresh per-element decoder would otherwise repeat.
    local_decoder.seed_unit_scales(unit_scale, seed_plane_angle_to_radians);

    let entity = match local_decoder.decode_at(job.start, job.end) {
        Ok(entity) => entity,
        Err(_) => return Vec::new(),
    };

    let mut local_router = GeometryRouter::with_scale_and_quality(unit_scale, tessellation_quality);
    local_router.set_rtc_offset(rtc_offset);
    // content-dedup default OFF: its structural hash costs more than the meshing
    // it skips on real models (see GeometryRouter::content_dedup_enabled).
    if GeometryRouter::content_dedup_enabled() {
        local_router.enable_content_dedup_shared(item_dedup_cache.clone());
    }
    let local_router = local_router;

    let metadata = crate::element::ElementMeshMetadata {
        global_id: job.global_id.clone(),
        name: job.name.clone(),
        presentation_layer: job.presentation_layer.clone(),
        space_zone_properties: job.space_zone_properties.clone(),
    };
    // #957: the scan loop plans type geometry with `SuppressInstanced` (see
    // `plan_type_geometry`), so a synthetic job's map always renders as an
    // orphan — geometry_class 1.
    let kind = match job.representation_map_id {
        Some(rep_map_id) => crate::element::ElementJobKind::TypeProduct {
            rep_maps: vec![(rep_map_id, 1)],
        },
        None => crate::element::ElementJobKind::Product,
    };
    let ctx = crate::element::MeshProductionContext {
        void_index,
        geometry_style_index,
        indexed_colour_full,
        element_material_colors,
        texture_index,
        site_local_rotation,
    };

    let produced = crate::element::produce_element_meshes(
        &crate::element::ElementMeshJob {
            id: job.id,
            ifc_type: job.ifc_type,
            entity: &entity,
            kind,
            element_color: Some(job.element_color),
            metadata: Some(&metadata),
        },
        &ctx,
        // Geometry hashing is a viewer diff feature — off on the native path.
        &crate::element::MeshProductionOptions::default(),
        &mut local_decoder,
        &local_router,
    );

    // Fold this element's degenerate-backstop drops into the pass tally.
    if produced.degenerate_triangles_dropped > 0 {
        backstop_collector.fetch_add(
            produced.degenerate_triangles_dropped,
            std::sync::atomic::Ordering::Relaxed,
        );
    }

    // Surface this element's CSG diagnostics in the shared collector. The
    // wasm path logs them in the browser console; without this the server
    // would silently discard every failed opening cut.
    if !produced.csg_failures.is_empty() {
        if let Ok(mut collector) = csg_failure_collector.lock() {
            for (product_id, fails) in produced.csg_failures {
                collector.entry(product_id).or_default().extend(fails);
            }
        }
    }

    // Drain this job's router opening diagnostics (classification counts +
    // per-host detail) and merge them. Each job uses a FRESH router that
    // processed exactly this one element, so the drained values are this
    // element's only — summing across jobs mirrors the wasm batch router's
    // accumulate-then-drain, giving the same GeometryDiagnostics counts.
    let cls = local_router.take_classification_stats();
    if cls.rectangular != 0
        || cls.diagonal != 0
        || cls.non_rectangular != 0
        || cls.floor_opening_guard_saved != 0
    {
        if let Ok(mut acc) = classification_collector.lock() {
            acc.rectangular += cls.rectangular;
            acc.diagonal += cls.diagonal;
            acc.non_rectangular += cls.non_rectangular;
            acc.floor_opening_guard_saved += cls.floor_opening_guard_saved;
        }
    }
    let host_diags = local_router.take_host_opening_diagnostics();
    if !host_diags.is_empty() {
        if let Ok(mut acc) = host_diag_collector.lock() {
            // Product ids are disjoint across jobs (one product = one job), so this
            // is an insert; `extend` is robust if that ever changes.
            acc.extend(host_diags);
        }
    }
    // Drain this job's router rect_fast counters into the request-local collector
    // (process-global counters are gone — see GeometryRouter::record_rect_fast).
    let rf = local_router.take_rect_fast_stats();
    if rf.fired != 0
        || rf.openings_cut != 0
        || rf.defer_host_not_box != 0
        || rf.defer_not_through != 0
        || rf.defer_off_face != 0
        || rf.defer_near_edge != 0
        || rf.defer_no_openings != 0
    {
        if let Ok(mut acc) = rect_fast_collector.lock() {
            acc.fired += rf.fired;
            acc.openings_cut += rf.openings_cut;
            acc.defer_host_not_box += rf.defer_host_not_box;
            acc.defer_not_through += rf.defer_not_through;
            acc.defer_off_face += rf.defer_off_face;
            acc.defer_near_edge += rf.defer_near_edge;
            acc.defer_no_openings += rf.defer_no_openings;
        }
    }

    produced.meshes
}



fn build_color_updates_for_jobs(
    jobs: &[EntityJob],
    geometry_styles: &FxHashMap<u32, GeometryStyleInfo>,
    content: &[u8],
    entity_index: &Arc<EntityIndex>,
) -> Vec<(u32, [f32; 4])> {
    let mut decoder = EntityDecoder::with_arc_index(content, entity_index.clone());
    let mut updates: Vec<(u32, [f32; 4])> = Vec::new();

    for job in jobs {
        // #957: synthetic type-only-geometry jobs resolve their colour from the
        // RepresentationMap (a type has no IfcProductDefinitionShape), so the
        // product-definition path below never corrects them. Backfill them here
        // or a deferred IfcStyledItem (fast_first_batch) leaves the orphan type
        // geometry stuck at its fallback colour.
        if let Some(rep_map_id) = job.representation_map_id {
            if let Some(color) = crate::element::resolve_color_for_representation_map(
                rep_map_id,
                geometry_styles,
                &mut decoder,
            ) {
                if color != job.element_color {
                    updates.push((job.id, color));
                }
            }
            continue;
        }
        let Ok(entity) = decoder.decode_at(job.start, job.end) else {
            continue;
        };
        let Some(product_definition_shape_id) = entity.get_ref(6) else {
            continue;
        };
        let Some(color) = resolve_element_color_for_product_definition_shape(
            product_definition_shape_id,
            geometry_styles,
            &mut decoder,
        ) else {
            continue;
        };
        if color != job.element_color {
            updates.push((job.id, color));
        }
    }

    updates
}


// Default IFC-type colors now come from the single canonical table in
// `crate::style::default_color_for_type` (issue #913). Do not reintroduce a
// per-module table here — see `tests/styling_parity.rs` for the guard.

#[cfg(test)]
mod tests {
    use super::*;

    #[allow(dead_code)] // test helper retained for building index fixtures
    fn map(pairs: &[(u32, &[u32])]) -> FxHashMap<u32, Vec<u32>> {
        pairs.iter().map(|(k, v)| (*k, v.to_vec())).collect()
    }

    // `find_geometry_item_color_follows_mapped_item` lives in
    // `crate::element::tests`, next to the resolver it pins.
}
