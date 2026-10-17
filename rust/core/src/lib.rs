// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! # IFC-Lite Core Parser
//!
//! High-performance STEP/IFC parser built with [nom](https://docs.rs/nom).
//! Provides zero-copy tokenization and fast entity scanning for IFC files.
//!
//! ## Overview
//!
//! This crate provides the core parsing functionality for IFC-Lite:
//!
//! - **STEP Tokenization**: Zero-copy parsing of STEP file format
//! - **Entity Scanning**: SIMD-accelerated entity discovery using [memchr](https://docs.rs/memchr)
//! - **Lazy Decoding**: On-demand attribute parsing for memory efficiency
//! - **Streaming Parser**: Event-based parsing for large files
//!
//! ## Quick Start
//!
//! ```rust,ignore
//! use ifc_lite_core::{EntityScanner, parse_entity, IfcType};
//!
//! // Scan for entities
//! let content = br#"#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);"#;
//! let mut scanner = EntityScanner::new(content);
//!
//! while let Some((id, type_name, start, end)) = scanner.next_entity() {
//!     println!("Found entity #{}: {}", id, type_name);
//! }
//!
//! // Parse individual entity
//! let input = b"#123=IFCWALL('guid',$,$,$,$,$,$,$);";
//! let (id, ifc_type, attrs) = parse_entity(input).unwrap();
//! assert_eq!(ifc_type, IfcType::IfcWall);
//! ```
//!
//! ## Streaming Parser
//!
//! For large files, use the streaming parser to process entities in batches:
//!
//! ```rust,ignore
//! use ifc_lite_core::{parse_stream, StreamConfig, ParseEvent};
//!
//! let config = StreamConfig::default();
//! for event in parse_stream(content, config) {
//!     match event {
//!         ParseEvent::Entity { id, type_name, .. } => {
//!             println!("Entity #{}: {}", id, type_name);
//!         }
//!         ParseEvent::Progress { percent, .. } => {
//!             println!("Progress: {:.1}%", percent);
//!         }
//!         _ => {}
//!     }
//! }
//! ```
//!
//! ## Performance
//!
//! - **Tokenization**: ~1,259 MB/s throughput
//! - **Entity scanning**: ~650 MB/s with SIMD acceleration
//! - **Number parsing**: one shared reader ([`read_step_number`]) over `fast-float2`

pub mod attribute_slot;
pub mod columnar_index;
pub mod compatibility;
pub mod decoder;
pub mod dense_index;
pub mod error;
pub mod express_id;
pub mod fast_parse;
pub mod fmt_num;
pub mod generated;
pub mod guid;
pub mod hash;
pub mod georef;
pub mod limits;
pub mod model_bounds;
pub mod parser;
pub mod project_locator;
pub mod project_units;
pub mod schema_family;
pub mod schema_gen;
pub(crate) mod schema_helpers;
pub mod step_encoding;
pub mod slot;
pub mod streaming;
pub mod unit_labels;
pub mod units;

#[cfg(test)]
#[path = "schema_registry_tests.rs"]
mod schema_registry_tests;

pub use attribute_slot::{AttrKind, AttrSlot};
pub use columnar_index::{ColumnLengthMismatch, ColumnarEntityIndex, SpanBeyondU32};
pub use compatibility::{is_exporter_stratum_alias, EXPORTER_STRATUM_ALIASES};
pub use decoder::{build_entity_index, EntityDecoder, EntityIndex, GridAxisIndex};
pub use dense_index::DenseEntityIndex;
pub use error::{Error, Result};
pub use fast_parse::{
    extract_coordinate_list_from_entity, extract_coordinate_list_from_entity_f64,
    extract_entity_refs_from_list, extract_entity_type_name,
    extract_face_indices_from_entity, extract_first_entity_ref, parse_coordinates_direct,
    parse_indices_direct, process_triangulated_faceset_direct, should_use_fast_path, FastMeshData,
    INVALID_INDEX,
};
pub use generated::{
    attribute_names_for_schema, entity_info_for_schema, is_subtype_of_for_schema, IfcType,
    SchemaEntityInfo, SchemaVersion, UnknownIfcType, IFC_TYPES,
};
pub use georef::{GeoRefExtractor, GeoRefSource, GeoReference};
pub use limits::{RtcVerdict, MAX_CONTEXT_DEPTH, MAX_MAPPED_ITEM_DEPTH, MAX_PLACEMENT_DEPTH};
pub use model_bounds::{scan_model_bounds, scan_placement_bounds, ModelBounds};
pub use parser::{
    declared_schema_bounded, entity_count, find_keyword, keyword_ends_with, keyword_eq, keyword_starts_with,
    nth_attribute_is_present, oversized_id_report, parse_entity, parse_step_real, read_step_number, report_malformed_records,
    report_oversized_ids, report_scan_diagnostics, set_report_sink, skip_step_comment,
    EntityScanner, StepListItems, StepNumber, Token,
};
pub use project_locator::{find_project_id, find_project_ids};
pub use project_units::{
    measure::{measure_unit, MeasureUnit},
    resolve_unit_by_ref, ProjectUnits, ResolvedUnit, UnitScales,
};
pub use schema_family::SchemaFamily;
pub use schema_gen::{AttributeValue, DecodedEntity, GeometryCategory, IfcSchema, ProfileCategory};
pub use schema_helpers::{
    geometry_flags_by_name, has_geometry_by_name, is_representationless_spatial_container_by_name,
    ifc_type_from_keyword, ifc_type_from_record, is_simple_geometry_type, type_product_ifc_type,
};
pub use step_encoding::{decode_ifc_string, decode_step_binary};
pub use streaming::{parse_stream, ParseEvent, StreamConfig};
pub use unit_labels::{
    is_us_survey_foot_key, is_us_survey_foot_tokens, si_prefix, SiPrefix, SI_PREFIXES, US_SURVEY_FOOT_M,
};
pub use units::{
    extract_length_unit_scale, extract_plane_angle_to_radians, get_si_prefix_multiplier,
    resolve_length_unit, LengthUnit,
    try_extract_length_unit_scale, try_extract_plane_angle_to_radians,
};
