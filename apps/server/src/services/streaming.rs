// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Streaming geometry processing with Server-Sent Events.
//!
//! Thin bridge over the canonical `ifc_lite_processing` pipeline: the
//! blocking task runs `process_geometry_streaming_filtered_with_options`
//! (the same code path as `POST /api/v1/parse` and the wasm
//! `processGeometryBatch` boundary) and forwards its batch callbacks through
//! an unbounded channel as [`StreamEvent`]s.
//!
//! This file used to host a third, bespoke geometry pipeline with its own
//! scan, style index (SurfaceColour-only, no material chain, no indexed
//! colour maps), no aggregate void propagation, no submeshes and no type
//! geometry — meshes streamed from `/parse/stream` could differ from every
//! other surface (alignment audit). Supersede means delete: it is gone, and
//! the streaming endpoints inherit every pipeline feature (and bug fix)
//! automatically, including `opening_filter` support which the bespoke
//! pipeline never had.

use crate::services::cache::DiskCache;
use crate::types::StreamEvent;
use async_stream::stream;
use futures::Stream;
use ifc_lite_processing::{
    extract_symbolic_data, process_geometry_streaming_filtered_with_options, OpeningFilterMode,
    StreamingOptions, TessellationQuality,
};
use std::pin::Pin;
use tokio::sync::mpsc;

/// Generate streaming geometry events backed by the canonical pipeline.
pub fn process_streaming(
    content: String,
    initial_batch_size: usize,
    max_batch_size: usize,
    opening_filter: OpeningFilterMode,
    tessellation_quality: TessellationQuality,
) -> Pin<Box<dyn Stream<Item = StreamEvent> + Send>> {
    let (tx, mut rx) = mpsc::unbounded_channel::<StreamEvent>();

    let handle = tokio::task::spawn_blocking(move || {
        let cache_key = DiskCache::generate_key(content.as_bytes());

        let mut started = false;
        let mut batch_number = 0usize;
        let mut last_type = String::new();

        let result = process_geometry_streaming_filtered_with_options(
            &content,
            opening_filter,
            StreamingOptions {
                initial_batch_size,
                throughput_batch_size: max_batch_size,
                tessellation_quality,
                // Batches are forwarded as they are emitted — retaining them
                // in the ProcessingResult would double peak memory.
                retain_emitted_meshes: false,
                ..StreamingOptions::default()
            },
            |meshes, processed, total| {
                if !started {
                    started = true;
                    let _ = tx.send(StreamEvent::Start {
                        total_estimate: total,
                    });
                    let _ = tx.send(StreamEvent::Progress {
                        processed: 0,
                        total,
                        current_type: "indexing".into(),
                    });
                }
                if let Some(mesh) = meshes.last() {
                    last_type = mesh.ifc_type.clone();
                }
                if !meshes.is_empty() {
                    batch_number += 1;
                    let _ = tx.send(StreamEvent::Batch {
                        meshes: meshes.to_vec(),
                        batch_number,
                    });
                }
                let _ = tx.send(StreamEvent::Progress {
                    processed,
                    total,
                    current_type: last_type.clone(),
                });
            },
            // Styling is eager on this path (`fast_first_batch` defaults to
            // false), so colour updates never fire.
            |_| {},
            |_| {},
        );

        if !started {
            // Zero-geometry model: the batch callback never ran. Emit Start
            // so consumers still observe the Start → Complete contract.
            let _ = tx.send(StreamEvent::Start { total_estimate: 0 });
        }

        // 2D symbolic stream (IfcAnnotation + IfcGrid) on the same blocking
        // thread — parity with the synchronous endpoints (issue #900).
        // Georeferencing already rides in `result.metadata`.
        let symbolic_data = extract_symbolic_data(&content);

        let _ = tx.send(StreamEvent::Complete {
            stats: result.stats,
            metadata: result.metadata,
            cache_key,
            mesh_coordinate_space: result.mesh_coordinate_space,
            site_transform: result.site_transform,
            building_transform: result.building_transform,
            symbolic_data,
        });
        // `tx` drops here, closing the channel and ending the stream below.
    });

    Box::pin(stream! {
        while let Some(event) = rx.recv().await {
            yield event;
        }
        // Surface a panicked/cancelled blocking task as a stream error
        // instead of silently truncating the SSE stream.
        if let Err(e) = handle.await {
            yield StreamEvent::Error {
                message: format!("Streaming geometry task failed: {e}"),
            };
        }
    })
}
