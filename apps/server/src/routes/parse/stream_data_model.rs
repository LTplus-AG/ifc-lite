// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The streamed parse's background data-model fill: what its serialization
//! result leaves in the cache. Split out of `parquet_stream.rs` for the
//! module-size rule.

use super::cache_keys::data_model_refusal_key;
use crate::services::parquet_data_model::DataModelParquetError;
use crate::services::cache::DiskCache;

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
