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
//! let content = r#"#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);"#;
//! let mut scanner = EntityScanner::new(content);
//!
//! while let Some((id, type_name, start, end)) = scanner.next_entity() {
//!     println!("Found entity #{}: {}", id, type_name);
//! }
//!
//! // Parse individual entity
//! let input = "#123=IFCWALL('guid',$,$,$,$,$,$,$);";
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
//! - **Number parsing**: 10x faster than std using [lexical-core](https://docs.rs/lexical-core)
//!
//! ## Feature Flags
//!
//! - `serde`: Enable serialization support for parsed data

pub mod decoder;
pub mod error;
pub mod fast_parse;
pub mod generated;
pub mod georef;
pub mod legacy_entities;
pub mod model_bounds;
pub mod parser;
pub mod schema_gen;
pub mod schema_helpers;
pub mod streaming;
pub mod units;

pub use decoder::{build_entity_index, EntityDecoder, EntityIndex};
pub use error::{Error, Result};
pub use fast_parse::{
    extract_coordinate_list_from_entity, extract_entity_refs_from_list, extract_entity_type_name,
    extract_face_indices_from_entity, extract_first_entity_ref, parse_coordinates_direct,
    parse_indices_direct, process_triangulated_faceset_direct, should_use_fast_path, FastMeshData,
};
pub use generated::IfcType;
pub use georef::{GeoRefExtractor, GeoReference, RtcOffset};
pub use legacy_entities::{
    get_legacy_entity_info, is_legacy_entity, map_legacy_to_base_type, LegacyEntityInfo,
};
pub use model_bounds::{scan_model_bounds, scan_placement_bounds, ModelBounds};
pub use parser::{parse_entity, EntityScanner, Token};
pub use schema_gen::{AttributeValue, DecodedEntity, GeometryCategory, IfcSchema, ProfileCategory};
pub use schema_helpers::has_geometry_by_name;
pub use streaming::{parse_stream, ParseEvent, StreamConfig};
pub use units::{extract_length_unit_scale, get_si_prefix_multiplier};
