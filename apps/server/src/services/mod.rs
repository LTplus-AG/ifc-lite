// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Service modules for IFC processing and caching.

pub mod cache;
pub mod data_model;
pub mod parquet;
pub mod parquet_data_model;
pub mod parquet_optimized;
pub mod processor;
pub mod streaming;

pub use data_model::extract_data_model;
pub use parquet::{serialize_to_parquet, ParquetError};
pub use parquet_data_model::serialize_data_model_to_parquet;
pub use parquet_optimized::{
    serialize_to_parquet_optimized_with_stats, OptimizedStats, VERTEX_MULTIPLIER,
};
pub use processor::OpeningFilterMode;
pub use streaming::process_streaming;
