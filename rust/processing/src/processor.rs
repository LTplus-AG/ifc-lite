// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IFC processing service with parallel geometry extraction.
//!
//! Originally contributed by Mathias Søndergaard (Sonderwoods/Linkajou).

use crate::types::mesh::MeshData;
use crate::types::response::{
    CoordinateInfo, ModelMetadata, ProcessingStats, QuickMetadataBootstrap,
    QuickMetadataEntitySummary, QuickMetadataSpatialNode,
};
use ifc_lite_core::{
    build_entity_index, scan_placement_bounds, AttributeValue, DecodedEntity, EntityDecoder,
    EntityIndex, EntityScanner, IfcType,
};
use ifc_lite_geometry::{calculate_normals, GeometryRouter};
use rayon::prelude::*;
use rustc_hash::FxHashMap;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

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
#[derive(Debug, Clone, Copy)]
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
        }
    }
}

const SITE_LOCAL_MESH_COORDINATE_SPACE: &str = "site_local";
const MODEL_RTC_MESH_COORDINATE_SPACE: &str = "model_rtc";
const RAW_IFC_MESH_COORDINATE_SPACE: &str = "raw_ifc";

/// Epsilon (metres) below which a placement translation is treated as identity.
/// Avoids overriding a detected RTC anchor when `IfcSite` sits at the origin
/// while the geometry itself carries large world coordinates.
const PLACEMENT_IDENTITY_EPSILON: f64 = 1e-9;

#[inline]
fn translation_is_nonidentity(t: (f64, f64, f64)) -> bool {
    t.0.abs() > PLACEMENT_IDENTITY_EPSILON
        || t.1.abs() > PLACEMENT_IDENTITY_EPSILON
        || t.2.abs() > PLACEMENT_IDENTITY_EPSILON
}

/// Apply the inverse of the site placement's 3×3 rotation to in-place `f32`
/// triplets (positions or normals). Translation is handled separately via the
/// router's `rtc_offset`; this only rotates vertices into the site-local axis
/// frame when that frame is non-identity.
fn apply_inverse_rotation_in_place(values: &mut [f32], column_major_matrix: &[f64]) {
    if values.len() < 3 || column_major_matrix.len() < 16 {
        return;
    }

    let r00 = column_major_matrix[0];
    let r10 = column_major_matrix[1];
    let r20 = column_major_matrix[2];
    let r01 = column_major_matrix[4];
    let r11 = column_major_matrix[5];
    let r21 = column_major_matrix[6];
    let r02 = column_major_matrix[8];
    let r12 = column_major_matrix[9];
    let r22 = column_major_matrix[10];

    let is_identity = (r00 - 1.0).abs() < PLACEMENT_IDENTITY_EPSILON
        && r10.abs() < PLACEMENT_IDENTITY_EPSILON
        && r20.abs() < PLACEMENT_IDENTITY_EPSILON
        && r01.abs() < PLACEMENT_IDENTITY_EPSILON
        && (r11 - 1.0).abs() < PLACEMENT_IDENTITY_EPSILON
        && r21.abs() < PLACEMENT_IDENTITY_EPSILON
        && r02.abs() < PLACEMENT_IDENTITY_EPSILON
        && r12.abs() < PLACEMENT_IDENTITY_EPSILON
        && (r22 - 1.0).abs() < PLACEMENT_IDENTITY_EPSILON;
    if is_identity {
        return;
    }

    for chunk in values.chunks_exact_mut(3) {
        let x = chunk[0] as f64;
        let y = chunk[1] as f64;
        let z = chunk[2] as f64;
        chunk[0] = (r00 * x + r10 * y + r20 * z) as f32;
        chunk[1] = (r01 * x + r11 * y + r21 * z) as f32;
        chunk[2] = (r02 * x + r12 * y + r22 * z) as f32;
    }
}

/// Rotate a mesh into the site-local axis frame. Only runs for the
/// `site_local` coordinate-space tier; translation alignment happens upstream
/// via the router's RTC subtraction.
///
/// Exposed so the streaming server can apply the same rotation to meshes it
/// produces outside this crate's parallel loop.
pub fn convert_mesh_to_site_local(mesh: &mut MeshData, site_transform: Option<&Vec<f64>>) {
    let Some(site_transform) = site_transform else {
        return;
    };

    apply_inverse_rotation_in_place(&mut mesh.positions, site_transform);
    apply_inverse_rotation_in_place(&mut mesh.normals, site_transform);
}

/// Job for processing a single entity.
struct EntityJob {
    id: u32,
    ifc_type: IfcType,
    start: usize,
    end: usize,
    product_definition_shape_id: Option<u32>,
    element_color: [f32; 4],
    global_id: Option<String>,
    name: Option<String>,
    presentation_layer: Option<String>,
    space_zone_properties: Option<BTreeMap<String, String>>,
}

fn populate_entity_job_metadata(
    job: &mut EntityJob,
    geometry_style_index: &FxHashMap<u32, GeometryStyleInfo>,
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

#[derive(Debug, Clone)]
struct GeometryStyleInfo {
    color: [f32; 4],
    material_name: Option<String>,
}

#[derive(Debug, Clone)]
struct PropertySetDefinition {
    name: Option<String>,
    property_ids: Vec<u32>,
}

#[derive(Debug, Clone)]
struct RelDefinesByPropertiesLink {
    property_set_id: u32,
    related_object_ids: Vec<u32>,
}

/// Extract entity references from a list attribute.
fn get_refs_from_list(entity: &DecodedEntity, index: usize) -> Option<Vec<u32>> {
    let list = entity.get_list(index)?;
    let refs: Vec<u32> = list.iter().filter_map(|v| v.as_entity_ref()).collect();
    if refs.is_empty() {
        None
    } else {
        Some(refs)
    }
}

fn normalize_optional_string(raw: Option<&str>) -> Option<String> {
    let value = raw?.trim();
    if value.is_empty() || value == "$" {
        return None;
    }
    Some(value.to_string())
}

fn normalize_ifc_property_name(raw: Option<&str>) -> Option<String> {
    let name = normalize_optional_string(raw)?;
    let cleaned = name.trim();
    if cleaned.is_empty() {
        return None;
    }

    Some(cleaned.to_string())
}

fn is_space_or_zone_type(ifc_type: &IfcType) -> bool {
    matches!(
        ifc_type,
        IfcType::IfcSpace
            | IfcType::IfcSpaceType
            | IfcType::IfcZone
            | IfcType::IfcSpatialZone
            | IfcType::IfcSpatialZoneType
    )
}

fn collect_property_set_definition(property_set: &DecodedEntity) -> Option<PropertySetDefinition> {
    let property_ids = property_set
        .get_list(4)
        .or_else(|| property_set.get_list(2))
        .map(|items| {
            items
                .iter()
                .filter_map(AttributeValue::as_entity_ref)
                .collect::<Vec<u32>>()
        })
        .unwrap_or_default();

    if property_ids.is_empty() {
        return None;
    }

    let name = normalize_optional_string(property_set.get_string(2))
        .or_else(|| normalize_optional_string(property_set.get_string(0)));

    Some(PropertySetDefinition { name, property_ids })
}

fn collect_rel_defines_by_properties_link(
    rel_defines: &DecodedEntity,
) -> Option<RelDefinesByPropertiesLink> {
    let property_set_id = rel_defines.get_ref(5).or_else(|| rel_defines.get_ref(3))?;
    let related_object_ids = rel_defines
        .get_list(4)
        .or_else(|| rel_defines.get_list(2))
        .map(|items| {
            items
                .iter()
                .filter_map(AttributeValue::as_entity_ref)
                .collect::<Vec<u32>>()
        })
        .unwrap_or_default();

    if related_object_ids.is_empty() {
        return None;
    }

    Some(RelDefinesByPropertiesLink {
        property_set_id,
        related_object_ids,
    })
}

fn attribute_list_to_string(values: &[AttributeValue]) -> Option<String> {
    let tokens = values
        .iter()
        .filter_map(attribute_value_to_string)
        .collect::<Vec<String>>();

    if tokens.is_empty() {
        return None;
    }

    Some(tokens.join("; "))
}

fn attribute_value_to_string(value: &AttributeValue) -> Option<String> {
    match value {
        AttributeValue::Null | AttributeValue::Derived => None,
        AttributeValue::String(text) => normalize_optional_string(Some(text)),
        AttributeValue::Enum(text) => normalize_optional_string(Some(text.trim_matches('.'))),
        AttributeValue::Integer(number) => Some(number.to_string()),
        AttributeValue::Float(number) => Some(number.to_string()),
        AttributeValue::EntityRef(id) => Some(format!("#{id}")),
        AttributeValue::List(values) => {
            if values.len() >= 2 && matches!(values.first(), Some(AttributeValue::String(_))) {
                return values.get(1).and_then(attribute_value_to_string);
            }

            attribute_list_to_string(values)
        }
    }
}

fn extract_property_name_and_value(property_entity: &DecodedEntity) -> Option<(String, String)> {
    let property_name = normalize_ifc_property_name(property_entity.get_string(0))
        .or_else(|| normalize_ifc_property_name(property_entity.get_string(2)))?;

    let property_type = property_entity.ifc_type.name();
    let value = match property_type {
        "IfcPropertySingleValue" => property_entity.get(2).and_then(attribute_value_to_string),
        "IfcPropertyEnumeratedValue" => property_entity.get(2).and_then(attribute_value_to_string),
        "IfcPropertyListValue" => property_entity.get(2).and_then(attribute_value_to_string),
        "IfcPropertyBoundedValue" => {
            let lower = property_entity.get(2).and_then(attribute_value_to_string);
            let upper = property_entity.get(3).and_then(attribute_value_to_string);
            match (lower, upper) {
                (Some(lo), Some(hi)) => Some(format!("{lo}..{hi}")),
                (Some(lo), None) => Some(lo),
                (None, Some(hi)) => Some(hi),
                (None, None) => None,
            }
        }
        "IfcPropertyReferenceValue" => property_entity.get(2).and_then(attribute_value_to_string),
        _ => None,
    }?;

    let normalized_value = value.trim();
    if normalized_value.is_empty() || normalized_value == "$" {
        return None;
    }

    Some((property_name, normalized_value.to_string()))
}

fn add_space_zone_property(
    attributes: &mut BTreeMap<String, String>,
    property_set_name: Option<&str>,
    property_name: &str,
    property_value: &str,
) {
    if property_name.trim().is_empty() || property_value.trim().is_empty() {
        return;
    }

    attributes
        .entry(property_name.to_string())
        .or_insert_with(|| property_value.to_string());

    if let Some(pset_name) = normalize_optional_string(property_set_name) {
        let scoped_name = format!("{}.{}", pset_name, property_name);
        attributes
            .entry(scoped_name)
            .or_insert_with(|| property_value.to_string());
    }
}

fn build_space_zone_properties_by_entity(
    entity_jobs: &[EntityJob],
    property_values_by_id: &FxHashMap<u32, (String, String)>,
    property_sets_by_id: &FxHashMap<u32, PropertySetDefinition>,
    rel_defines_by_properties: &[RelDefinesByPropertiesLink],
) -> FxHashMap<u32, BTreeMap<String, String>> {
    let mut target_space_zone_ids = FxHashMap::default();
    for job in entity_jobs
        .iter()
        .filter(|job| is_space_or_zone_type(&job.ifc_type))
    {
        target_space_zone_ids.insert(job.id, ());
    }

    if target_space_zone_ids.is_empty() {
        return FxHashMap::default();
    }

    let mut properties_by_entity: FxHashMap<u32, BTreeMap<String, String>> = FxHashMap::default();

    for link in rel_defines_by_properties {
        let Some(property_set) = property_sets_by_id.get(&link.property_set_id) else {
            continue;
        };

        for related_id in &link.related_object_ids {
            if !target_space_zone_ids.contains_key(related_id) {
                continue;
            }

            let attributes = properties_by_entity.entry(*related_id).or_default();
            for property_id in &property_set.property_ids {
                let Some((property_name, property_value)) = property_values_by_id.get(property_id)
                else {
                    continue;
                };

                add_space_zone_property(
                    attributes,
                    property_set.name.as_deref(),
                    property_name,
                    property_value,
                );
            }
        }
    }

    properties_by_entity
}

fn assign_space_zone_properties(
    entity_jobs: &mut [EntityJob],
    property_values_by_id: &FxHashMap<u32, (String, String)>,
    property_sets_by_id: &FxHashMap<u32, PropertySetDefinition>,
    rel_defines_by_properties: &[RelDefinesByPropertiesLink],
) {
    let properties_by_entity = build_space_zone_properties_by_entity(
        entity_jobs,
        property_values_by_id,
        property_sets_by_id,
        rel_defines_by_properties,
    );

    if properties_by_entity.is_empty() {
        return;
    }

    for job in entity_jobs.iter_mut() {
        if let Some(properties) = properties_by_entity.get(&job.id) {
            job.space_zone_properties = Some(properties.clone());
        }
    }
}

#[derive(Clone)]
struct QuickSpatialNodeEntry {
    express_id: u32,
    type_name: String,
    name: String,
    elevation: Option<f64>,
    children: Vec<u32>,
    elements: Vec<u32>,
    parent: Option<u32>,
}

fn is_quick_spatial_type(type_upper: &str) -> bool {
    matches!(
        type_upper,
        "IFCPROJECT"
            | "IFCSITE"
            | "IFCBUILDING"
            | "IFCBUILDINGSTOREY"
            | "IFCSPACE"
            | "IFCFACILITY"
            | "IFCFACILITYPART"
            | "IFCBRIDGE"
            | "IFCBRIDGEPART"
            | "IFCROAD"
            | "IFCROADPART"
            | "IFCRAILWAY"
            | "IFCRAILWAYPART"
    )
}

/// Case-insensitive variant that avoids to_ascii_uppercase() allocation.
#[inline]
fn is_quick_spatial_type_ci(type_name: &str) -> bool {
    type_name.eq_ignore_ascii_case("IFCPROJECT")
        || type_name.eq_ignore_ascii_case("IFCSITE")
        || type_name.eq_ignore_ascii_case("IFCBUILDING")
        || type_name.eq_ignore_ascii_case("IFCBUILDINGSTOREY")
        || type_name.eq_ignore_ascii_case("IFCSPACE")
        || type_name.eq_ignore_ascii_case("IFCFACILITY")
        || type_name.eq_ignore_ascii_case("IFCFACILITYPART")
        || type_name.eq_ignore_ascii_case("IFCBRIDGE")
        || type_name.eq_ignore_ascii_case("IFCBRIDGEPART")
        || type_name.eq_ignore_ascii_case("IFCROAD")
        || type_name.eq_ignore_ascii_case("IFCROADPART")
        || type_name.eq_ignore_ascii_case("IFCRAILWAY")
        || type_name.eq_ignore_ascii_case("IFCRAILWAYPART")
}

fn parse_step_arguments<'a>(entity_text: &'a str) -> Vec<&'a str> {
    let Some(open_idx) = entity_text.find('(') else {
        return Vec::new();
    };
    let Some(close_idx) = entity_text.rfind(')') else {
        return Vec::new();
    };
    if close_idx <= open_idx {
        return Vec::new();
    }
    let args = &entity_text[open_idx + 1..close_idx];
    let mut parts = Vec::new();
    let mut in_string = false;
    let mut depth = 0i32;
    let mut start = 0usize;
    let bytes = args.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\'' => {
                if in_string && index + 1 < bytes.len() && bytes[index + 1] == b'\'' {
                    index += 1;
                } else {
                    in_string = !in_string;
                }
            }
            b'(' if !in_string => depth += 1,
            b')' if !in_string => depth -= 1,
            b',' if !in_string && depth == 0 => {
                parts.push(args[start..index].trim());
                start = index + 1;
            }
            _ => {}
        }
        index += 1;
    }
    if start <= args.len() {
        parts.push(args[start..].trim());
    }
    parts
}

fn parse_step_string(token: &str) -> Option<String> {
    let trimmed = token.trim();
    if trimmed.len() < 2 || !trimmed.starts_with('\'') || !trimmed.ends_with('\'') {
        return None;
    }
    Some(trimmed[1..trimmed.len() - 1].replace("''", "'"))
}

fn parse_step_ref(token: &str) -> Option<u32> {
    token.trim().strip_prefix('#')?.parse::<u32>().ok()
}

fn parse_step_ref_list(token: &str) -> Vec<u32> {
    let trimmed = token.trim();
    let inner = trimmed
        .strip_prefix('(')
        .and_then(|value| value.strip_suffix(')'))
        .unwrap_or(trimmed);
    inner.split(',').filter_map(parse_step_ref).collect()
}

fn extract_name_from_args(args: &[&str], fallback: &str) -> String {
    args.get(2)
        .and_then(|token| parse_step_string(token))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn extract_storey_elevation_from_args(args: &[&str]) -> Option<f64> {
    for index in [9usize, 8usize] {
        if let Some(value) = args.get(index).and_then(|token| token.trim().parse::<f64>().ok()) {
            return Some(value);
        }
    }
    args.iter()
        .filter_map(|token| token.trim().parse::<f64>().ok())
        .find(|value| value.abs() < 10_000.0)
}

fn build_quick_spatial_tree_node(
    express_id: u32,
    nodes: &HashMap<u32, QuickSpatialNodeEntry>,
    element_summaries: &HashMap<u32, QuickMetadataEntitySummary>,
) -> Result<QuickMetadataSpatialNode, String> {
    let node = nodes
        .get(&express_id)
        .ok_or_else(|| format!("Quick spatial node #{express_id} not found"))?;
    let mut children = Vec::with_capacity(node.children.len());
    for child_id in &node.children {
        children.push(build_quick_spatial_tree_node(*child_id, nodes, element_summaries)?);
    }
    let elements = node
        .elements
        .iter()
        .map(|element_id| {
            element_summaries.get(element_id).cloned().unwrap_or(QuickMetadataEntitySummary {
                express_id: *element_id,
                type_name: "IfcProduct".to_string(),
                name: format!("IfcProduct #{}", element_id),
                global_id: None,
                kind: "element".to_string(),
                has_children: false,
                element_count: None,
                elevation: None,
            })
        })
        .collect();
    Ok(QuickMetadataSpatialNode {
        summary: QuickMetadataEntitySummary {
            express_id: node.express_id,
            type_name: node.type_name.clone(),
            name: node.name.clone(),
            global_id: None,
            kind: "spatial".to_string(),
            has_children: !node.children.is_empty() || !node.elements.is_empty(),
            element_count: Some(node.elements.len()),
            elevation: node.elevation,
        },
        children,
        elements,
    })
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
pub fn process_geometry(content: &str) -> ProcessingResult {
    process_geometry_filtered(content, OpeningFilterMode::Default)
}

/// Process IFC content with parallel geometry extraction and emit batches as they complete.
pub fn process_geometry_streaming(
    content: &str,
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
    content: &str,
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
    content: &str,
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
pub fn process_geometry_filtered(content: &str, opening_filter: OpeningFilterMode) -> ProcessingResult {
    process_geometry_streaming_filtered_with_options(
        content,
        opening_filter,
        StreamingOptions {
            initial_batch_size: usize::MAX,
            throughput_batch_size: usize::MAX,
            ..StreamingOptions::default()
        },
        |_, _, _| {},
        |_| {},
        |_| {},
    )
}

/// Process IFC content with parallel geometry extraction and a configurable streaming batch size.
pub fn process_geometry_streaming_filtered(
    content: &str,
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
    content: &str,
    opening_filter: OpeningFilterMode,
    options: StreamingOptions,
    mut on_batch: impl FnMut(&[MeshData], usize, usize),
    mut on_color_update: impl FnMut(&[(u32, [f32; 4])]),
    mut on_quick_metadata_bootstrap: impl FnMut(&QuickMetadataBootstrap),
) -> ProcessingResult {
    let total_start = std::time::Instant::now();
    let parse_start = std::time::Instant::now();
    let entity_scan_start = std::time::Instant::now();

    tracing::info!(
        content_size = content.len(),
        "Starting IFC geometry processing"
    );

    // Build entity index (fast SIMD-accelerated single pass)
    let entity_index = Arc::new(build_entity_index(content));
    let mut decoder = EntityDecoder::with_arc_index(content, entity_index.clone());
    tracing::debug!("Built entity index");

    let mut geometry_style_index: FxHashMap<u32, GeometryStyleInfo> = FxHashMap::default();
    let mut presentation_layer_by_assigned_id: FxHashMap<u32, String> = FxHashMap::default();
    let mut property_values_by_id: FxHashMap<u32, (String, String)> = FxHashMap::default();
    let mut property_sets_by_id: FxHashMap<u32, PropertySetDefinition> = FxHashMap::default();
    let mut rel_defines_by_properties: Vec<RelDefinesByPropertiesLink> = Vec::new();

    // Collect geometry entities and build void index
    let mut scanner = EntityScanner::new(content);
    let mut faceted_brep_ids: Vec<u32> = Vec::new();
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut filling_by_opening: FxHashMap<u32, u32> = FxHashMap::default();
    let mut entity_jobs: Vec<EntityJob> = Vec::with_capacity(2000);
    let quick_metadata_enabled = options.emit_quick_metadata_bootstrap;
    let mut quick_spatial_nodes = quick_metadata_enabled.then(HashMap::<u32, QuickSpatialNodeEntry>::new);
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
    let mut quick_element_summaries = if quick_metadata_enabled {
        HashMap::<u32, QuickMetadataEntitySummary>::new()
    } else {
        HashMap::new()
    };
    let mut schema_version = "IFC2X3".to_string();
    let mut total_entities = 0usize;
    let mut site_entity_pos: Option<(usize, usize)> = None;
    let mut building_entity_pos: Option<(usize, usize)> = None;

    let defer_style_updates =
        options.fast_first_batch &&
        opening_filter == OpeningFilterMode::Default &&
        !options.include_presentation_layers;
    let mut deferred_styled_item_positions: Vec<(usize, usize)> = Vec::new();

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
            } else if type_name.eq_ignore_ascii_case("IFCRELCONTAINEDINSPATIALSTRUCTURE")
                || type_name.eq_ignore_ascii_case("IFCRELREFERENCEDINSPATIALSTRUCTURE")
            {
                let args = parse_step_arguments(&content[start..end]);
                if let Some(parent_id) = args.get(5).and_then(|token| parse_step_ref(token)) {
                    quick_containment_links.push((
                        parent_id,
                        args.get(4)
                            .map(|token| parse_step_ref_list(token))
                            .unwrap_or_default(),
                    ));
                }
            }
        }

        if type_name == "IFCSTYLEDITEM" {
            if defer_style_updates {
                // Record byte positions so we can rebuild the style index
                // without re-scanning the entire file.
                deferred_styled_item_positions.push((start, end));
                continue;
            }
            if let Ok(styled_item) = decoder.decode_at(start, end) {
                collect_geometry_style_info(&mut geometry_style_index, &styled_item, &mut decoder);
            }
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
        } else if type_name == "IFCFACETEDBREP" {
            faceted_brep_ids.push(id);
        } else if type_name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at(start, end) {
                if let (Some(host), Some(opening)) = (entity.get_ref(4), entity.get_ref(5)) {
                    void_index.entry(host).or_default().push(opening);
                }
            }
        } else if type_name == "IFCRELFILLSELEMENT" {
            if let Ok(entity) = decoder.decode_at(start, end) {
                // attr 4 = RelatingOpeningElement, attr 5 = RelatedBuildingElement (window/door)
                if let (Some(opening_id), Some(filling_id)) = (entity.get_ref(4), entity.get_ref(5))
                {
                    filling_by_opening.insert(opening_id, filling_id);
                }
            }
        } else if type_name == "IFCSITE" && site_entity_pos.is_none() {
            site_entity_pos = Some((start, end));
        } else if type_name == "IFCBUILDING" && building_entity_pos.is_none() {
            building_entity_pos = Some((start, end));
        }

        if ifc_lite_core::has_geometry_by_name(type_name) {
            let ifc_type = IfcType::from_str(type_name);
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
                ifc_type: ifc_type.clone(),
                start,
                end,
                product_definition_shape_id: None,
                element_color: get_default_color(&ifc_type),
                global_id: None,
                name: None,
                presentation_layer: None,
                space_zone_properties: None,
            });
        }
    }

    let entity_scan_time = entity_scan_start.elapsed();

    let lookup_start = std::time::Instant::now();
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

    let (skipped_entity_ids, filtered_void_index) = apply_opening_filter(
        &entity_jobs,
        &void_index,
        &filling_by_opening,
        &geometry_style_index,
        &mut decoder,
        opening_filter,
    );

    // Detect schema version
    if content.contains("IFC4X3") {
        schema_version = "IFC4X3".into();
    } else if content.contains("IFC4") {
        schema_version = "IFC4".into();
    }

    let geometry_entity_count = entity_jobs.len();
    tracing::info!(
        total_entities = total_entities,
        geometry_entities = geometry_entity_count,
        faceted_breps = faceted_brep_ids.len(),
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
            if let Some(parent) = spatial_nodes.get_mut(&parent_id) {
                parent.elements.extend(element_ids);
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
            .map(|root| build_quick_spatial_tree_node(root, &spatial_nodes, &quick_element_summaries))
            .transpose()
            .unwrap_or(None);
        on_quick_metadata_bootstrap(&QuickMetadataBootstrap {
            schema_version: schema_version.clone(),
            entity_count: total_entities,
            spatial_tree,
        });
    }

    // Preprocess complex geometry
    let preprocess_start = std::time::Instant::now();
    let mut router = GeometryRouter::with_units(content, &mut decoder);

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
    let detected_rtc_offset = match router.detect_rtc_offset_from_jobs(&rtc_jobs, &mut decoder) {
        Some(offset) => offset,
        None => scan_placement_bounds(content).rtc_offset(),
    };

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
    let should_preprocess_faceted_breps = !faceted_brep_ids.is_empty()
        && !(options.fast_first_batch && options.initial_batch_size < usize::MAX);
    if should_preprocess_faceted_breps {
        tracing::debug!(count = faceted_brep_ids.len(), "Preprocessing FacetedBreps");
        router.preprocess_faceted_breps(&faceted_brep_ids, &mut decoder);
    }
    let preprocess_time = preprocess_start.elapsed();

    let parse_time = parse_start.elapsed();
    tracing::info!(
        entity_scan_time_ms = entity_scan_time.as_millis(),
        lookup_time_ms = lookup_time.as_millis(),
        preprocess_time_ms = preprocess_time.as_millis(),
        parse_time_ms = parse_time.as_millis(),
        "Parse phase complete, starting geometry extraction"
    );

    // PARALLEL GEOMETRY PROCESSING
    let geometry_start = std::time::Instant::now();
    let entity_index_arc = entity_index; // Already Arc from above
    let unit_scale = router.unit_scale();
    let rtc_offset = router.rtc_offset();
    let void_index_arc = Arc::new(filtered_void_index);
    let skipped_entity_ids = Arc::new(skipped_entity_ids);
    let mut geometry_style_index = Arc::new(geometry_style_index);

    let total_jobs = entity_jobs.len();
    let initial_chunk_size = options.initial_batch_size.max(1);
    let throughput_chunk_size = options
        .throughput_batch_size
        .max(initial_chunk_size);
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

    while chunk_start < total_jobs {
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
                if job.global_id.is_some() || job.name.is_some()
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
                    void_index_arc.as_ref(),
                    skipped_entity_ids.as_ref(),
                    geometry_style_index.as_ref(),
                    site_local_rotation,
                )
            })
            .collect();

        processed_jobs += jobs_chunk.len();
        total_vertices += chunk_meshes.iter().map(|m| m.vertex_count()).sum::<usize>();
        total_triangles += chunk_meshes.iter().map(|m| m.triangle_count()).sum::<usize>();

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
                let mut rebuilt_styles: FxHashMap<u32, GeometryStyleInfo> = FxHashMap::default();
                {
                    let mut style_decoder = EntityDecoder::with_arc_index(content, entity_index_arc.clone());
                    for &(start, end) in &deferred_styled_item_positions {
                        if let Ok(styled_item) = style_decoder.decode_at(start, end) {
                            collect_geometry_style_info(&mut rebuilt_styles, &styled_item, &mut style_decoder);
                        }
                    }
                }
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
    let total_time = total_start.elapsed();

    tracing::info!(
        meshes = meshes.len(),
        vertices = total_vertices,
        triangles = total_triangles,
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
        },
    }
}

fn process_entity_job(
    job: &EntityJob,
    content: &str,
    entity_index_arc: &Arc<EntityIndex>,
    unit_scale: f64,
    rtc_offset: (f64, f64, f64),
    void_index: &FxHashMap<u32, Vec<u32>>,
    skipped_entity_ids: &HashSet<u32>,
    geometry_style_index: &FxHashMap<u32, GeometryStyleInfo>,
    /// Present only when the selected coordinate space is `site_local`;
    /// rotates mesh vertices into the site's axis frame.
    site_local_rotation: Option<&Vec<f64>>,
) -> Vec<MeshData> {
    if skipped_entity_ids.contains(&job.id) {
        return Vec::new();
    }

    let mut local_decoder = EntityDecoder::with_arc_index(content, entity_index_arc.clone());

    let entity = match local_decoder.decode_at(job.start, job.end) {
        Ok(entity) => entity,
        Err(_) => return Vec::new(),
    };

    let has_representation = entity.get(6).is_some_and(|a| !a.is_null());
    if !has_representation {
        return Vec::new();
    }

    let local_router = GeometryRouter::with_scale_and_rtc(unit_scale, rtc_offset);
    let global_id = job.global_id.clone();
    let name = job.name.clone();
    let presentation_layer = job.presentation_layer.clone();
    let space_zone_properties = job.space_zone_properties.clone();
    let element_color = job.element_color;

    if is_opening_with_subparts(&job.ifc_type) {
        if let Ok(sub_meshes) = local_router.process_element_with_submeshes(&entity, &mut local_decoder) {
            if !sub_meshes.is_empty() {
                let mut out: Vec<MeshData> = Vec::with_capacity(sub_meshes.len());

                for sub in sub_meshes.sub_meshes {
                    let mut sub_mesh = sub.mesh;
                    if sub_mesh.is_empty() {
                        continue;
                    }

                    if sub_mesh.normals.is_empty() {
                        calculate_normals(&mut sub_mesh);
                    }

                    let style = geometry_style_index.get(&sub.geometry_id);
                    let color = style.map(|s| s.color).unwrap_or(element_color);
                    let material_name = style
                        .and_then(|s| s.material_name.as_ref())
                        .map(ToString::to_string);
                    let material_name = material_name.or_else(|| {
                        infer_opening_subpart_material_name(&job.ifc_type, color, sub.geometry_id)
                    });

                    let mut mesh_data = MeshData::new(
                        job.id,
                        job.ifc_type.name().to_string(),
                        sub_mesh.positions,
                        sub_mesh.normals,
                        sub_mesh.indices,
                        color,
                    )
                    .with_element_metadata(global_id.clone(), name.clone(), presentation_layer.clone())
                    .with_properties(space_zone_properties.clone())
                    .with_style_metadata(material_name, Some(sub.geometry_id));
                    convert_mesh_to_site_local(&mut mesh_data, site_local_rotation);
                    out.push(mesh_data);
                }

                if !out.is_empty() {
                    return out;
                }
            }
        }
    }

    let mut mesh_candidate = local_router
        .process_element_with_voids(&entity, &mut local_decoder, void_index)
        .ok();
    let needs_fallback = match mesh_candidate.as_ref() {
        Some(mesh) => mesh.is_empty(),
        None => true,
    };
    if needs_fallback {
        mesh_candidate = local_router.process_element(&entity, &mut local_decoder).ok();
    }

    if let Some(mut mesh) = mesh_candidate {
        if !mesh.is_empty() {
            if mesh.normals.is_empty() {
                calculate_normals(&mut mesh);
            }

            let mut mesh_data = MeshData::new(
                job.id,
                job.ifc_type.name().to_string(),
                mesh.positions,
                mesh.normals,
                mesh.indices,
                element_color,
            )
            .with_element_metadata(global_id, name, presentation_layer)
            .with_properties(space_zone_properties);
            convert_mesh_to_site_local(&mut mesh_data, site_local_rotation);
            return vec![mesh_data];
        }
    }

    Vec::new()
}

fn collect_geometry_style_info(
    geometry_styles: &mut FxHashMap<u32, GeometryStyleInfo>,
    styled_item: &DecodedEntity,
    decoder: &mut EntityDecoder,
) {
    let Some(geometry_id) = styled_item.get_ref(0) else {
        return;
    };

    if geometry_styles.contains_key(&geometry_id) {
        return;
    }

    if let Some(style_info) = extract_style_info_from_styled_item(styled_item, decoder) {
        geometry_styles.insert(geometry_id, style_info);
    }
}

fn build_geometry_style_index(
    content: &str,
    entity_index: &Arc<EntityIndex>,
) -> FxHashMap<u32, GeometryStyleInfo> {
    let mut geometry_styles: FxHashMap<u32, GeometryStyleInfo> = FxHashMap::default();
    let mut decoder = EntityDecoder::with_arc_index(content, entity_index.clone());
    let mut scanner = EntityScanner::new(content);

    while let Some((_id, type_name, start, end)) = scanner.next_entity() {
        if type_name != "IFCSTYLEDITEM" {
            continue;
        }
        if let Ok(styled_item) = decoder.decode_at(start, end) {
            collect_geometry_style_info(&mut geometry_styles, &styled_item, &mut decoder);
        }
    }

    geometry_styles
}

fn build_color_updates_for_jobs(
    jobs: &[EntityJob],
    geometry_styles: &FxHashMap<u32, GeometryStyleInfo>,
    content: &str,
    entity_index: &Arc<EntityIndex>,
) -> Vec<(u32, [f32; 4])> {
    let mut decoder = EntityDecoder::with_arc_index(content, entity_index.clone());
    let mut updates: Vec<(u32, [f32; 4])> = Vec::new();

    for job in jobs {
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

fn collect_presentation_layer_assignments(
    layer_by_assigned_representation: &mut FxHashMap<u32, String>,
    layer_assignment: &DecodedEntity,
) {
    let Some(layer_name) = normalize_optional_string(layer_assignment.get_string(0)) else {
        return;
    };

    let Some(assigned_items) = get_refs_from_list(layer_assignment, 2) else {
        return;
    };

    for assigned in assigned_items {
        layer_by_assigned_representation
            .entry(assigned)
            .or_insert_with(|| layer_name.clone());
    }
}

fn resolve_element_color_for_product_definition_shape(
    product_definition_shape_id: u32,
    geometry_styles: &FxHashMap<u32, GeometryStyleInfo>,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    find_color_in_representation(product_definition_shape_id, geometry_styles, decoder)
}

fn resolve_presentation_layer_for_product_definition_shape(
    product_definition_shape_id: u32,
    layer_by_assigned_representation: &FxHashMap<u32, String>,
    cache_by_representation: &mut FxHashMap<u32, Option<String>>,
    decoder: &mut EntityDecoder,
) -> Option<String> {
    if let Some(layer_name) = layer_by_assigned_representation.get(&product_definition_shape_id) {
        return Some(layer_name.clone());
    }

    let product_definition_shape = decoder.decode_by_id(product_definition_shape_id).ok()?;
    let representation_ids = get_refs_from_list(&product_definition_shape, 2)?;

    for representation_id in representation_ids {
        if let Some(layer_name) = resolve_presentation_layer_name(
            representation_id,
            layer_by_assigned_representation,
            cache_by_representation,
            decoder,
            &mut Vec::new(),
        ) {
            return Some(layer_name);
        }
    }

    None
}

fn resolve_presentation_layer_name(
    representation_id: u32,
    layer_by_assigned_representation: &FxHashMap<u32, String>,
    cache_by_representation: &mut FxHashMap<u32, Option<String>>,
    decoder: &mut EntityDecoder,
    traversal_stack: &mut Vec<u32>,
) -> Option<String> {
    if let Some(cached) = cache_by_representation.get(&representation_id) {
        return cached.clone();
    }

    if traversal_stack.contains(&representation_id) {
        return None;
    }
    traversal_stack.push(representation_id);

    if let Some(layer_name) = layer_by_assigned_representation.get(&representation_id) {
        let result = Some(layer_name.clone());
        cache_by_representation.insert(representation_id, result.clone());
        traversal_stack.pop();
        return result;
    }

    let mut resolved: Option<String> = None;

    if let Ok(representation) = decoder.decode_by_id(representation_id) {
        if let Some(items) = get_refs_from_list(&representation, 3) {
            for item_id in items {
                if let Some(layer_name) = layer_by_assigned_representation.get(&item_id) {
                    resolved = Some(layer_name.clone());
                    break;
                }

                if let Ok(item) = decoder.decode_by_id(item_id) {
                    if item.ifc_type == IfcType::IfcMappedItem {
                        if let Some(mapping_source_id) = item.get_ref(0) {
                            if let Ok(mapping_source) = decoder.decode_by_id(mapping_source_id) {
                                if let Some(mapped_representation_id) = mapping_source.get_ref(1) {
                                    if let Some(layer_name) = resolve_presentation_layer_name(
                                        mapped_representation_id,
                                        layer_by_assigned_representation,
                                        cache_by_representation,
                                        decoder,
                                        traversal_stack,
                                    ) {
                                        resolved = Some(layer_name);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    traversal_stack.pop();
    cache_by_representation.insert(representation_id, resolved.clone());
    resolved
}

/// Find a color in a representation by traversing its items.
fn find_color_in_representation(
    repr_id: u32,
    geometry_styles: &FxHashMap<u32, GeometryStyleInfo>,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    // Decode the IfcProductDefinitionShape
    let repr = decoder.decode_by_id(repr_id).ok()?;

    // Attribute 2: Representations (list of IfcRepresentation)
    let repr_list = get_refs_from_list(&repr, 2)?;

    for shape_repr_id in repr_list {
        if let Ok(shape_repr) = decoder.decode_by_id(shape_repr_id) {
            // Attribute 3: Items (list of IfcRepresentationItem)
            if let Some(items) = get_refs_from_list(&shape_repr, 3) {
                for item_id in items {
                    // Check direct style
                    if let Some(style) = geometry_styles.get(&item_id) {
                        return Some(style.color);
                    }

                    // Check mapped items
                    if let Ok(item) = decoder.decode_by_id(item_id) {
                        if item.ifc_type == IfcType::IfcMappedItem {
                            if let Some(source_id) = item.get_ref(0) {
                                if let Ok(source) = decoder.decode_by_id(source_id) {
                                    if let Some(mapped_repr_id) = source.get_ref(1) {
                                        if let Some(color) = find_color_in_shape_representation(
                                            mapped_repr_id,
                                            geometry_styles,
                                            decoder,
                                        ) {
                                            return Some(color);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    None
}

/// Find color in a shape representation.
fn find_color_in_shape_representation(
    repr_id: u32,
    geometry_styles: &FxHashMap<u32, GeometryStyleInfo>,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    let repr = decoder.decode_by_id(repr_id).ok()?;
    let items = get_refs_from_list(&repr, 3)?;

    for item_id in items {
        if let Some(style) = geometry_styles.get(&item_id) {
            return Some(style.color);
        }
    }

    None
}

/// Extract color from an IfcStyledItem by traversing style references.
fn extract_style_info_from_styled_item(
    styled_item: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<GeometryStyleInfo> {
    let style_refs = get_refs_from_list(styled_item, 1)?;

    for style_id in style_refs {
        if let Ok(style) = decoder.decode_by_id(style_id) {
            // IfcPresentationStyleAssignment has nested style refs at attr 0.
            if let Some(inner_refs) = get_refs_from_list(&style, 0) {
                for inner_id in inner_refs {
                    if let Some(info) = extract_surface_style_info(inner_id, decoder) {
                        return Some(info);
                    }
                }
            }

            // Or the style ref points directly to IfcSurfaceStyle.
            if let Some(info) = extract_surface_style_info(style_id, decoder) {
                return Some(info);
            }
        }
    }

    None
}

/// Extract color + style name from an IfcSurfaceStyle.
fn extract_surface_style_info(
    style_id: u32,
    decoder: &mut EntityDecoder,
) -> Option<GeometryStyleInfo> {
    let style = decoder.decode_by_id(style_id).ok()?;
    let material_name = normalize_style_name(style.get_string(0));

    // IfcSurfaceStyle: Attr 2 = Styles (list of rendering styles)
    let rendering_refs = get_refs_from_list(&style, 2)?;

    for rendering_id in rendering_refs {
        if let Ok(rendering) = decoder.decode_by_id(rendering_id) {
            // IfcSurfaceStyleRendering: Attr 0 = SurfaceColour
            if let Some(color_id) = rendering.get_ref(0) {
                if let Ok(color) = decoder.decode_by_id(color_id) {
                    // IfcColourRgb: Attr 1 = Red, Attr 2 = Green, Attr 3 = Blue
                    let r = color.get_float(1).unwrap_or(0.8) as f32;
                    let g = color.get_float(2).unwrap_or(0.8) as f32;
                    let b = color.get_float(3).unwrap_or(0.8) as f32;

                    // Transparency: 0.0 = opaque, 1.0 = transparent
                    let alpha: f32 = 1.0 - rendering.get_float(1).unwrap_or(0.0) as f32;

                    return Some(GeometryStyleInfo {
                        color: [r, g, b, alpha.clamp(0.0, 1.0)],
                        material_name: material_name.clone(),
                    });
                }
            }
        }
    }

    None
}

fn normalize_style_name(raw: Option<&str>) -> Option<String> {
    let name = raw?.trim();
    if name.is_empty() || name == "$" {
        return None;
    }

    if name.eq_ignore_ascii_case("<unnamed>") || name.eq_ignore_ascii_case("unnamed") {
        return None;
    }

    Some(name.to_string())
}

/// Apply the opening filter and return which entity IDs to suppress and a filtered void index.
///
/// Returns `(skipped_entity_ids, filtered_void_index)` where:
/// - `skipped_entity_ids` is the set of IfcWindow/IfcDoor entity IDs to omit from geometry output
/// - `filtered_void_index` is the void index with suppressed openings removed from host lists
fn apply_opening_filter(
    entity_jobs: &[EntityJob],
    void_index: &FxHashMap<u32, Vec<u32>>,
    filling_by_opening: &FxHashMap<u32, u32>,
    geometry_style_index: &FxHashMap<u32, GeometryStyleInfo>,
    decoder: &mut EntityDecoder,
    mode: OpeningFilterMode,
) -> (HashSet<u32>, FxHashMap<u32, Vec<u32>>) {
    if mode == OpeningFilterMode::Default {
        return (HashSet::default(), void_index.clone());
    }

    // Collect all IfcWindow / IfcDoor entity jobs.
    let filling_jobs: FxHashMap<u32, &EntityJob> = entity_jobs
        .iter()
        .filter(|job| matches!(job.ifc_type, IfcType::IfcWindow | IfcType::IfcDoor))
        .map(|job| (job.id, job))
        .collect();

    if filling_jobs.is_empty() {
        return (HashSet::default(), void_index.clone());
    }

    let mut skipped_entity_ids: HashSet<u32> = HashSet::default();

    // IgnoreAll: suppress every window/door mesh and clear ALL wall voids.
    // We always clear the full void_index because IfcRelFillsElement is often absent
    // or only partially present, and without it we cannot identify which specific openings
    // belong to windows/doors.
    if mode == OpeningFilterMode::IgnoreAll {
        for (&id, _) in &filling_jobs {
            skipped_entity_ids.insert(id);
        }
        return (skipped_entity_ids, FxHashMap::default());
    }

    // IgnoreOpaque: suppress only windows/doors that have no transparent sub-parts.
    // Mesh suppression uses element color + style traversal (is_opaque_opening).
    // Void suppression uses IfcRelFillsElement data when available.
    for (&id, job) in &filling_jobs {
        if is_opaque_opening(job, geometry_style_index, decoder) {
            skipped_entity_ids.insert(id);
        }
    }

    if filling_by_opening.is_empty() {
        // No IfcRelFillsElement — can't map voids to specific window/door entities.
        return (skipped_entity_ids, void_index.clone());
    }

    // Build openings_to_suppress from the explicit opening → filling mapping.
    let mut openings_to_suppress: HashSet<u32> = HashSet::default();
    for (&opening_id, &filling_id) in filling_by_opening {
        if skipped_entity_ids.contains(&filling_id) {
            openings_to_suppress.insert(opening_id);
        }
    }

    if openings_to_suppress.is_empty() {
        return (skipped_entity_ids, void_index.clone());
    }

    let mut filtered: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    for (&host_id, openings) in void_index {
        let remaining: Vec<u32> = openings
            .iter()
            .copied()
            .filter(|oid| !openings_to_suppress.contains(oid))
            .collect();
        if !remaining.is_empty() {
            filtered.insert(host_id, remaining);
        }
    }

    (skipped_entity_ids, filtered)
}

/// Returns `true` when the entity has no transparent or glass sub-parts,
/// meaning it is an opaque window/door that should be suppressed by `IgnoreOpaque`.
///
/// Any of the following makes it NOT opaque (returns `false`):
/// - Entity name contains "glas" (case-insensitive)
/// - Resolved element color has any transparency (alpha < 1.0)
/// - Any sub-geometry style has alpha < 1.0 or a material/style name containing "glas"
fn is_opaque_opening(
    job: &EntityJob,
    styles: &FxHashMap<u32, GeometryStyleInfo>,
    decoder: &mut EntityDecoder,
) -> bool {
    let Ok(entity) = decoder.decode_at(job.start, job.end) else {
        return true;
    };

    // 1. Entity name contains "glas" → glazed.
    if normalize_optional_string(entity.get_string(2))
        .as_deref()
        .map(|n| n.to_lowercase().contains("glas"))
        .unwrap_or(false)
    {
        return false;
    }

    // 2. Resolved element color has any transparency → glazed.
    //    Covers IfcWindow entities using their default colour ([0.6, 0.8, 1.0, 0.4])
    //    and any entity whose explicit surface style resolved to a transparent colour.
    if job.element_color[3] < 1.0 {
        return false;
    }

    let Some(product_shape_id) = entity.get_ref(6) else {
        return true; // No shape info — treat as opaque
    };

    let Ok(product_shape) = decoder.decode_by_id(product_shape_id) else {
        return true;
    };

    let Some(repr_ids) = get_refs_from_list(&product_shape, 2) else {
        return true;
    };

    for repr_id in repr_ids {
        let Ok(repr) = decoder.decode_by_id(repr_id) else {
            continue;
        };
        let Some(item_ids) = get_refs_from_list(&repr, 3) else {
            continue;
        };
        for item_id in item_ids {
            // Direct style on item
            if let Some(style) = styles.get(&item_id) {
                if has_glass_style(style) {
                    return false;
                }
            }

            // Mapped items: IfcMappedItem → IfcRepresentationMap → IfcRepresentation → items
            if let Ok(item) = decoder.decode_by_id(item_id) {
                if item.ifc_type == IfcType::IfcMappedItem {
                    if let Some(source_id) = item.get_ref(0) {
                        if let Ok(source) = decoder.decode_by_id(source_id) {
                            if let Some(mapped_repr_id) = source.get_ref(1) {
                                if let Ok(mapped_repr) = decoder.decode_by_id(mapped_repr_id) {
                                    if let Some(mapped_items) = get_refs_from_list(&mapped_repr, 3)
                                    {
                                        for mapped_item_id in mapped_items {
                                            if let Some(style) = styles.get(&mapped_item_id) {
                                                if has_glass_style(style) {
                                                    return false;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    true // No glass found → opaque
}

/// Returns `true` when a geometry style indicates a glass/transparent material.
///
/// Triggers on:
/// - Any transparency at all (alpha < 1.0)
/// - Style/material name containing "glas" (case-insensitive)
fn has_glass_style(style: &GeometryStyleInfo) -> bool {
    if style.color[3] < 1.0 {
        return true;
    }
    if style
        .material_name
        .as_deref()
        .map(|n| n.to_lowercase().contains("glas"))
        .unwrap_or(false)
    {
        return true;
    }
    false
}

fn is_opening_with_subparts(ifc_type: &IfcType) -> bool {
    matches!(ifc_type, IfcType::IfcWindow | IfcType::IfcDoor)
}

fn infer_opening_subpart_material_name(
    ifc_type: &IfcType,
    color: [f32; 4],
    geometry_id: u32,
) -> Option<String> {
    if !is_opening_with_subparts(ifc_type) {
        return None;
    }

    let prefix = match ifc_type {
        IfcType::IfcDoor => "Door",
        _ => "Window",
    };

    // Transparency is a practical proxy for glazing in many BIM exports.
    if color[3] <= 0.65 {
        return Some(format!("{}_Glass", prefix));
    }

    Some(format!("{}_Frame_{}", prefix, geometry_id))
}

/// Get default color based on IFC type.
fn get_default_color(ifc_type: &IfcType) -> [f32; 4] {
    match ifc_type {
        // Walls - light gray
        IfcType::IfcWall | IfcType::IfcWallStandardCase => [0.85, 0.85, 0.85, 1.0],

        // Slabs - darker gray
        IfcType::IfcSlab => [0.7, 0.7, 0.7, 1.0],

        // Roofs - brown-ish
        IfcType::IfcRoof => [0.6, 0.5, 0.4, 1.0],

        // Columns/Beams - steel gray
        IfcType::IfcColumn | IfcType::IfcBeam | IfcType::IfcMember => [0.6, 0.65, 0.7, 1.0],

        // Windows - light blue transparent
        IfcType::IfcWindow => [0.6, 0.8, 1.0, 0.4],

        // Doors - wood brown
        IfcType::IfcDoor => [0.6, 0.45, 0.3, 1.0],

        // Stairs
        IfcType::IfcStair | IfcType::IfcStairFlight => [0.75, 0.75, 0.75, 1.0],

        // Railings
        IfcType::IfcRailing => [0.4, 0.4, 0.45, 1.0],

        // Plates/Coverings
        IfcType::IfcPlate | IfcType::IfcCovering => [0.8, 0.8, 0.8, 1.0],

        // Furniture
        IfcType::IfcFurnishingElement => [0.5, 0.35, 0.2, 1.0],

        // Space - cyan transparent (matches MainToolbar)
        IfcType::IfcSpace => [0.2, 0.85, 1.0, 0.3],

        // Opening elements - red-orange transparent
        IfcType::IfcOpeningElement => [1.0, 0.42, 0.29, 0.4],

        // Site - green
        IfcType::IfcSite => [0.4, 0.8, 0.3, 1.0],

        // Building element proxy - generic gray
        IfcType::IfcBuildingElementProxy => [0.6, 0.6, 0.6, 1.0],

        // Default - neutral gray
        _ => [0.8, 0.8, 0.8, 1.0],
    }
}
