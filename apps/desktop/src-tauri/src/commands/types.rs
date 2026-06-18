// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Wire types for the Tauri commands.
//!
//! Field names are serialized `camelCase` to match exactly what the
//! `@ifc-lite/geometry` `NativeBridge` (`native-bridge.ts` /
//! `native-bridge-conversion.ts`) reads off `invoke` results and `listen`
//! event payloads. Do not rename without updating that contract.

use ifc_lite_desktop_engine::{EngineStats, WireMesh};
use serde::Serialize;

/// One mesh in the non-streaming `get_geometry` result (`NativeMeshData`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMeshData {
    pub express_id: u32,
    pub ifc_type: String,
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub indices: Vec<u32>,
    pub color: [f32; 4],
}

impl From<WireMesh> for NativeMeshData {
    fn from(m: WireMesh) -> Self {
        Self {
            express_id: m.express_id,
            ifc_type: m.ifc_type,
            positions: m.positions,
            normals: m.normals,
            indices: m.indices,
            color: m.color,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Point3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Bounds {
    pub min: Point3,
    pub max: Point3,
}

/// `NativeCoordinateInfo`. The desktop engine emits meshes already anchored
/// (site-local / origin-folded); the viewer's own `coordinateHandler` derives
/// the RTC shift from the mesh stream, so the bounds here are left at their
/// defaults and `hasLargeCoordinates` is reported false.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinateInfo {
    pub origin_shift: Point3,
    pub original_bounds: Bounds,
    pub shifted_bounds: Bounds,
    pub has_large_coordinates: bool,
}

/// Result of `get_geometry` / `get_geometry_from_path` (`GeometryProcessingResult`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeometryResult {
    pub meshes: Vec<NativeMeshData>,
    pub total_vertices: usize,
    pub total_triangles: usize,
    pub coordinate_info: CoordinateInfo,
}

/// Aggregate stats returned by the streaming command (`GeometryStats`).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeometryStats {
    pub total_meshes: usize,
    pub total_vertices: usize,
    pub total_triangles: usize,
    pub parse_time_ms: u64,
    pub entity_scan_time_ms: u64,
    pub lookup_time_ms: u64,
    pub preprocess_time_ms: u64,
    pub geometry_time_ms: u64,
    pub total_time_ms: u64,
}

impl From<EngineStats> for GeometryStats {
    fn from(s: EngineStats) -> Self {
        Self {
            total_meshes: s.total_meshes,
            total_vertices: s.total_vertices,
            total_triangles: s.total_triangles,
            parse_time_ms: s.parse_time_ms,
            entity_scan_time_ms: s.entity_scan_time_ms,
            lookup_time_ms: s.lookup_time_ms,
            preprocess_time_ms: s.preprocess_time_ms,
            geometry_time_ms: s.geometry_time_ms,
            total_time_ms: s.total_time_ms,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeometryProgress {
    pub processed: usize,
    pub total: usize,
    pub current_type: String,
}

/// One mesh's range into the pooled arrays of a `geometry-packed-batch`
/// (`NativePackedMeshRange`). Offsets/lengths are in **elements** (floats for
/// positions/normals, u32s for indices); indices stay local to the mesh.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedMeshRange {
    pub express_id: u32,
    pub ifc_type: String,
    pub positions_offset: usize,
    pub positions_len: usize,
    pub normals_offset: usize,
    pub normals_len: usize,
    pub indices_offset: usize,
    pub indices_len: usize,
    pub color: [f32; 4],
}

/// Payload of the `geometry-packed-batch` event (`NativePackedGeometryBatch`):
/// per-batch pooled arrays plus the per-mesh ranges into them. One copy across
/// the IPC boundary per batch instead of per-mesh JSON objects.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedGeometryBatch {
    pub meshes: Vec<PackedMeshRange>,
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub indices: Vec<u32>,
    pub progress: GeometryProgress,
}

impl PackedGeometryBatch {
    /// Pool a batch of wire meshes into one positions/normals/indices array
    /// plus per-mesh ranges.
    pub fn from_wire(meshes: &[WireMesh], processed: usize, total: usize, current_type: &str) -> Self {
        let mut positions: Vec<f32> = Vec::new();
        let mut normals: Vec<f32> = Vec::new();
        let mut indices: Vec<u32> = Vec::new();
        let mut ranges = Vec::with_capacity(meshes.len());

        for m in meshes {
            let positions_offset = positions.len();
            let normals_offset = normals.len();
            let indices_offset = indices.len();
            positions.extend_from_slice(&m.positions);
            normals.extend_from_slice(&m.normals);
            indices.extend_from_slice(&m.indices);
            ranges.push(PackedMeshRange {
                express_id: m.express_id,
                ifc_type: m.ifc_type.clone(),
                positions_offset,
                positions_len: m.positions.len(),
                normals_offset,
                normals_len: m.normals.len(),
                indices_offset,
                indices_len: m.indices.len(),
                color: m.color,
            });
        }

        Self {
            meshes: ranges,
            positions,
            normals,
            indices,
            progress: GeometryProgress {
                processed,
                total,
                current_type: current_type.to_string(),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorUpdateEntry {
    pub express_id: u32,
    pub color: [f32; 4],
}

#[derive(Debug, Clone, Serialize)]
pub struct ColorUpdatePayload {
    pub updates: Vec<ColorUpdateEntry>,
}

/// Returned by `open_ifc_file` (`FileInfo`): the picked path and metadata, not
/// the file contents (the frontend reads bytes via the fs plugin or passes the
/// path to `get_geometry_from_path`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
}
