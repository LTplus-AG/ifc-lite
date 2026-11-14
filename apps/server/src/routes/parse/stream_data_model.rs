// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The streamed parse's background data-model fill: the task spawned off the
//! stream, and what its serialization result leaves in the cache. Split out of
//! `parquet_stream.rs` for the module-size rule.

use super::cache_keys::data_model_refusal_key;
use crate::services::parquet_data_model::DataModelParquetError;
use crate::services::cache::DiskCache;
use crate::services::{extract_data_model_with, serialize_data_model_to_parquet, DataModelOptions};
use std::sync::Arc;

/// Extract the data model and write it to its cache entry, off the stream.
///
/// Holds `_in_flight` for the task's whole lifetime (#5129) and `_admission`
/// for the request's (#7676, SERVER-8) -- see the call site in
/// `parquet_stream.rs` for why each must outlive the cache write.
pub(super) async fn fill_data_model_cache(
    content: bytes::Bytes,
    options: DataModelOptions,
    cache: Arc<DiskCache>,
    dm_key: String,
    _in_flight: crate::in_flight::InFlightGuard,
    _admission: Arc<crate::admission::AdmissionGuard>,
) {
    // The extraction applies the entities variant itself (#9582): this fill
    // runs beside the stream it was spawned from, so its peak is the one with
    // a ceiling.
    let dm_result = tokio::task::spawn_blocking(move || extract_data_model_with(&content, options)).await;

    if let Ok(data_model) = dm_result {
        let serialize_result =
            tokio::task::spawn_blocking(move || serialize_data_model_to_parquet(&data_model)).await;
        cache_streamed_data_model(&cache, &dm_key, serialize_result).await;
    }
    // `_in_flight` drops here, clearing the marker only after the cache write
    // (success or failure) is fully resolved.
}

/// Cache a serialized data model under `dm_key`, or record why it was refused
/// so `GET /parse/data-model` answers 400 with the reason instead of a 404
/// (#7675). Any other failure is logged, never dropped.
pub(super) async fn cache_streamed_data_model(
    cache: &DiskCache,
    dm_key: &str,
    serialized: Result<Result<Vec<u8>, DataModelParquetError>, tokio::task::JoinError>,
) {
    match serialized {
        Ok(Ok(parquet_data)) => {
            if let Err(e) = cache.set_bytes(dm_key, &parquet_data).await {
                tracing::error!(error = %e, "Failed to cache data model from stream");
            } else {
                tracing::info!(cache_key = %dm_key, size = parquet_data.len(), "Data model cached from stream");
            }
        }
        Ok(Err(DataModelParquetError::Refused(reason))) => {
            tracing::warn!(cache_key = %dm_key, %reason, "Data model refused from stream");
            if let Err(e) = cache.set_bytes(&data_model_refusal_key(dm_key), reason.as_bytes()).await {
                tracing::error!(error = %e, "Failed to record the data model refusal");
            }
        }
        Ok(Err(e)) => tracing::error!(error = %e, "Failed to serialize data model from stream"),
        Err(e) => tracing::error!(error = %e, "Data model serialization task failed"),
    }
}
