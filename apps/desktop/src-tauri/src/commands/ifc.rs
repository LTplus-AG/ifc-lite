// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IFC geometry commands.
//!
//! Thin Tauri wrappers over `ifc-lite-desktop-engine`. They run the engine on
//! the large-stack pool (see `crate::pool`) and shape its output into the
//! `NativeBridge` wire types. No IFC logic lives here — parsing, CSG, colour,
//! units and coordinate resolution are all the shared pipeline's job.

use super::types::{
    ColorUpdateEntry, ColorUpdatePayload, CoordinateInfo, GeometryResult, GeometryStats,
    NativeMeshData, PackedGeometryBatch,
};
use crate::pool::run_on_large_stack;
use ifc_lite_desktop_engine::{process_mesh_array, stream_wire_batches};
use tauri::Emitter;

/// First emitted batch is small (snappy first paint); steady state is larger
/// (throughput). Mirrors the server's `INITIAL_BATCH_SIZE` / `MAX_BATCH_SIZE`.
const INITIAL_BATCH_SIZE: usize = 50;
const THROUGHPUT_BATCH_SIZE: usize = 200;

fn build_result(wire: Vec<ifc_lite_desktop_engine::WireMesh>, stats: GeometryStats) -> GeometryResult {
    let meshes: Vec<NativeMeshData> = wire.into_iter().map(NativeMeshData::from).collect();
    GeometryResult {
        total_vertices: stats.total_vertices,
        total_triangles: stats.total_triangles,
        meshes,
        coordinate_info: CoordinateInfo::default(),
    }
}

/// Process IFC bytes and return all geometry at once (`processGeometry`).
#[tauri::command]
pub async fn get_geometry(buffer: Vec<u8>) -> Result<GeometryResult, String> {
    let (wire, stats) = run_on_large_stack(|| process_mesh_array(&buffer));
    Ok(build_result(wire, stats.into()))
}

/// Process IFC geometry directly from a filesystem path (`processGeometryPath`).
/// Reads the file natively so a large model never crosses the JS/IPC boundary.
#[tauri::command]
pub async fn get_geometry_from_path(path: String) -> Result<GeometryResult, String> {
    let content =
        std::fs::read(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let (wire, stats) = run_on_large_stack(move || process_mesh_array(&content));
    Ok(build_result(wire, stats.into()))
}

/// Process IFC bytes and stream geometry progressively (`processGeometryStreaming`).
///
/// Emits a `geometry-packed-batch` event per batch (pooled arrays + per-mesh
/// ranges) and `geometry-color-update` events for deferred colours, then returns
/// the aggregate stats. The viewer renders each batch as it arrives.
#[tauri::command]
pub async fn get_geometry_streaming(
    buffer: Vec<u8>,
    window: tauri::Window,
) -> Result<GeometryStats, String> {
    let stats = run_on_large_stack(move || {
        stream_wire_batches(
            &buffer,
            INITIAL_BATCH_SIZE,
            THROUGHPUT_BATCH_SIZE,
            |wire, processed, total| {
                let current_type = if processed >= total { "complete" } else { "streaming" };
                let batch = PackedGeometryBatch::from_wire(wire, processed, total, current_type);
                if let Err(e) = window.emit("geometry-packed-batch", batch) {
                    eprintln!("[desktop] failed to emit geometry-packed-batch: {e}");
                }
            },
            |updates| {
                if updates.is_empty() {
                    return;
                }
                let payload = ColorUpdatePayload {
                    updates: updates
                        .iter()
                        .map(|&(express_id, color)| ColorUpdateEntry { express_id, color })
                        .collect(),
                };
                if let Err(e) = window.emit("geometry-color-update", payload) {
                    eprintln!("[desktop] failed to emit geometry-color-update: {e}");
                }
            },
        )
    });

    Ok(stats.into())
}
