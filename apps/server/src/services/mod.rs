// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Service modules for IFC processing and caching.

pub mod cache;
pub mod parquet;
pub mod parquet_optimized;

// data_model (extraction) + parquet_data_model (serialization) moved to the
// shared ifc-lite-data-model crate so the native desktop backend can reuse
// them; re-exported under the original paths to avoid churn.
pub mod data_model {
    pub use ifc_lite_data_model::data_model::*;
}
pub mod parquet_data_model {
    pub use ifc_lite_data_model::parquet_data_model::*;
}
pub mod processor;
pub mod streaming;

pub use ifc_lite_data_model::extract_data_model;
pub use parquet::{serialize_to_parquet, ParquetError};
pub use ifc_lite_data_model::serialize_data_model_to_parquet;
pub use parquet_optimized::{
    serialize_to_parquet_optimized_with_stats, OptimizedStats, VERTEX_MULTIPLIER,
};
pub use processor::{process_geometry_filtered, OpeningFilterMode};
pub use streaming::process_streaming;
