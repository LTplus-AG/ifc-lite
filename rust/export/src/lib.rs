// SPDX-License-Identifier: MPL-2.0
//! Domain-format exporters for ifc-lite.
//!
//! This is the Rust source of truth for domain-format export; CLI / SDK / wasm become
//! thin callers (mirroring how geometry already flows through `ifc-lite-wasm`).
//!
//! Formats: OBJ, glTF/GLB, CSV, JSON, JSON-LD, STEP/IFC (re-serialize + schema conversion
//! + mutation bridge), IFC5/IFCX, Merged (multi-model), and a native-only ara3d BOS/Parquet
//! path. **HBJSON** (Honeybee energy model) lives in its own modules, added by the
//! `feat/hbjson-export` PR (this crate is the shared home for both).

mod csv;
mod gltf;
mod ifc5;
mod json;
mod jsonld;
mod merged;
mod model;
mod obj;
#[cfg(feature = "parquet-bos")]
mod parquet_bos;
mod schema_convert;
mod step;

pub use csv::{export_csv, CsvMode, CsvOptions};
pub use gltf::{export_glb, export_glb_from_meshes, export_glb_with_stats, GltfOptions, GltfStats};
pub use ifc5::{export_ifc5, Ifc5Options};
pub use json::{export_json, JsonOptions};
pub use jsonld::{export_jsonld, JsonLdOptions};
pub use merged::{export_merged, export_merged_with_stats, MergedOptions, MergedStats};
pub use model::{
    build_export_model, EntityRow, ExportModel, PropValue, PropertySet, QuantitySet, QuantityValue,
};
pub use obj::{export_obj, export_obj_with_stats, ObjOptions, ObjStats};
#[cfg(feature = "parquet-bos")]
pub use parquet_bos::{export_bos, ParquetBosOptions};
pub use step::{
    export_step, export_step_json, export_step_with_stats, AttrMutation, PropMutation, StepOptions,
    StepStats,
};
