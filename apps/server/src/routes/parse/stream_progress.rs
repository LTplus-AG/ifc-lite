// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The per-batch progress checkpoints a live parquet-stream parse reported,
//! cached so a later cache hit can replay the SAME numbers.
//!
//! `progress` events are in units of geometry JOBS, not meshes: the pipeline
//! calls its batch callback with `processed_jobs` / `total_jobs`
//! (`processing/src/processor/mod.rs`), and a job can produce several meshes
//! or none. A replay that counted the meshes it emitted would therefore
//! report different units AND a different total from a miss on the same file,
//! over the same public event. Nothing in the geometry blob records the job
//! counts, so the live path writes them here and the replay reads them back.

use crate::services::cache::DiskCache;
use serde::{Deserialize, Serialize};

/// Cache key for the checkpoint sidecar, keyed alongside the geometry and
/// metadata entries for the same request.
///
/// `v1` is `{ total_jobs, after_batch }`. Bump on any change to what those
/// numbers mean; an entry that fails to deserialize is treated as absent, so
/// a bump degrades to the mesh-unit fallback rather than to garbage.
pub(super) fn stream_progress_cache_key(cache_key: &str) -> String {
    format!("{cache_key}-parquet-progress-v1")
}

/// What a live parse reported, in job units.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub(super) struct StreamProgress {
    /// The `total` every `progress` event carried (the pipeline's `total_jobs`).
    pub total_jobs: usize,
    /// `processed_jobs` as of each `batch` event, in batch order. One entry
    /// per batch, so `after_batch.len()` must equal the replay's batch count
    /// for the checkpoints to line up.
    pub after_batch: Vec<usize>,
}

/// Collects [`StreamProgress`] from the live event stream.
///
/// The pipeline emits `Batch` then the `Progress` that accounts for it, so a
/// batch's checkpoint is the value of the NEXT progress event. Progress
/// events with no batch before them (the leading `processed: 0`, and any
/// chunk that produced no meshes) carry no batch to attach to and are only
/// used for `total_jobs`.
#[derive(Default)]
pub(super) struct StreamProgressRecorder {
    progress: StreamProgress,
    batch_pending: bool,
}

impl StreamProgressRecorder {
    pub(super) fn on_batch(&mut self) {
        self.batch_pending = true;
    }

    pub(super) fn on_progress(&mut self, processed: usize, total: usize) {
        self.progress.total_jobs = total;
        if self.batch_pending {
            self.progress.after_batch.push(processed);
            self.batch_pending = false;
        }
    }

    /// Take what was recorded, leaving the recorder empty.
    pub(super) fn take(&mut self) -> StreamProgress {
        std::mem::take(&mut self.progress)
    }
}

/// Store the checkpoints beside the geometry. Best-effort: a failure here
/// costs the next cache hit its job-unit progress, not its correctness.
pub(super) async fn cache_stream_progress(
    cache: &DiskCache,
    cache_key: &str,
    progress: &StreamProgress,
) {
    let Ok(bytes) = serde_json::to_vec(progress) else {
        return;
    };
    if let Err(e) = cache
        .set_bytes(&stream_progress_cache_key(cache_key), &bytes)
        .await
    {
        tracing::warn!(error = %e, "Failed to cache stream progress checkpoints");
    }
}

/// Read back the checkpoints for a cache hit. `None` for an entry written
/// before this sidecar existed, or one that no longer deserializes.
pub(super) async fn load_stream_progress(
    cache: &DiskCache,
    cache_key: &str,
) -> Option<StreamProgress> {
    let bytes = cache
        .get_bytes(&stream_progress_cache_key(cache_key))
        .await
        .ok()??;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
#[path = "stream_progress_tests.rs"]
mod stream_progress_tests;
