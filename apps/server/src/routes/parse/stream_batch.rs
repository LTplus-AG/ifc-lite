// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One streamed batch's CPU work on `POST /api/v1/parse/parquet-stream`: the
//! cache-writer append and the client blob, in either stream mode.
//!
//! Split out of `parquet_stream.rs` (module-size budget) along the seam #5407
//! added: this is the one place that decides whether a batch is planned
//! against the whole stream (cross-batch) or serialized on its own.

use crate::services::parquet_stream_shapes::StreamShapePlanner;
use crate::services::{serialize_batch_with_layout, ParquetError, ParquetLayout, StreamingParquetCacheWriter};
use crate::types::MeshData;
use bytes::Bytes;
use std::sync::Mutex;

/// A batch's client blob, and `(vertex_base, index_base)` when it was planned
/// against the whole stream.
pub(super) type EncodedBatch = (Bytes, Option<(u32, u32)>);

/// Append `meshes` to the cache fill and encode the client's blob.
///
/// Cross-batch (`planner` is `Some`): ONE plan feeds both the client blob and
/// the cache row group, so the two cannot disagree on a range. Batch-local:
/// the cache writer plans whole-stream offsets and the client blob stays
/// batch-local, as before. A cache-writer error drops the cache fill (the slot
/// goes `None`) and never the client's batch.
pub(super) fn encode_batch(
    meshes: &[MeshData],
    layout: ParquetLayout,
    baked_basis: Option<&[f64; 16]>,
    planner: Option<&mut StreamShapePlanner>,
    cache_writer: &Mutex<Option<StreamingParquetCacheWriter>>,
) -> Result<EncodedBatch, ParquetError> {
    let planned = planner.map(|p| p.plan(meshes, baked_basis)).transpose()?;
    if let Ok(mut slot) = cache_writer.lock() {
        if let Some(writer) = slot.as_mut() {
            let appended = match &planned {
                Some(batch) => writer.append_planned(batch),
                None => writer.append(meshes),
            };
            if let Err(e) = appended {
                tracing::error!(error = %e, "Streaming cache writer failed; skipping cache fill");
                *slot = None;
            }
        }
    }
    match planned {
        Some(batch) => Ok((batch.encode()?, Some((batch.vertex_base, batch.index_base)))),
        None => Ok((serialize_batch_with_layout(meshes, layout)?, None)),
    }
}

/// Run CPU-bound work from inside an async context without starving other
/// connections' polls: `block_in_place` on the multi-thread runtime, inline on
/// a current-thread one (where `block_in_place` panics, as under the
/// `#[tokio::test]` harness). Shared by the live stream and its cached replay.
pub(super) fn off_the_async_worker<T>(work: impl FnOnce() -> T) -> T {
    if tokio::runtime::Handle::current().runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread {
        tokio::task::block_in_place(work)
    } else {
        work()
    }
}
