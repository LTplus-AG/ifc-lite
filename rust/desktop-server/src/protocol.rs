// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Wire protocol for the geometry WebSocket, and the socket-agnostic streaming
//! core (so it can be unit-tested without a real socket).
//!
//! A client connects to `/geometry`, sends the IFC file as a single **binary**
//! frame, and receives:
//!
//! - **binary frames** — each a packed geometry shard
//!   ([`ifc_lite_desktop_engine::encode_shard`]); the browser decodes them with
//!   the same `packed-geometry-decoder.ts` layout.
//! - **text frames** — JSON control messages, tagged by `type`:
//!   - `{"type":"colorUpdate","updates":[[expressId,[r,g,b,a]], …]}`
//!   - `{"type":"done","stats":{…}}` (sent once, last)
//!   - `{"type":"error","message":"…"}`

use ifc_lite_desktop_engine::{stream_packed_shards, EngineStats};
use serde::Serialize;
use std::cell::RefCell;

/// First emitted batch is small (snappy first paint); steady state is larger
/// (throughput). Mirrors the server's `INITIAL_BATCH_SIZE` / `MAX_BATCH_SIZE`.
pub const INITIAL_BATCH_SIZE: usize = 50;
pub const THROUGHPUT_BATCH_SIZE: usize = 200;

/// One outbound frame: a binary packed shard, or a JSON text control message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutMessage {
    Shard(Vec<u8>),
    Control(String),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatsPayload {
    total_meshes: usize,
    total_vertices: usize,
    total_triangles: usize,
    parse_time_ms: u64,
    entity_scan_time_ms: u64,
    lookup_time_ms: u64,
    preprocess_time_ms: u64,
    geometry_time_ms: u64,
    total_time_ms: u64,
}

impl From<&EngineStats> for StatsPayload {
    fn from(s: &EngineStats) -> Self {
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

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ControlMessage<'a> {
    ColorUpdate { updates: Vec<(u32, [f32; 4])> },
    Done { stats: StatsPayload },
    Error { message: &'a str },
}

/// `{"type":"colorUpdate","updates":[[id,[r,g,b,a]], …]}`.
pub fn color_update_json(updates: &[(u32, [f32; 4])]) -> String {
    serde_json::to_string(&ControlMessage::ColorUpdate {
        updates: updates.to_vec(),
    })
    .expect("color update serialization is infallible")
}

/// `{"type":"done","stats":{…}}` — sent once, after all shards.
pub fn done_json(stats: &EngineStats) -> String {
    serde_json::to_string(&ControlMessage::Done {
        stats: StatsPayload::from(stats),
    })
    .expect("done serialization is infallible")
}

/// `{"type":"error","message":"…"}`.
pub fn error_json(message: &str) -> String {
    serde_json::to_string(&ControlMessage::Error { message })
        .expect("error serialization is infallible")
}

/// Run the native engine over `content`, handing every shard and colour update
/// to `emit` in order, and return the aggregate stats. Socket-agnostic: the WS
/// handler passes an `emit` that forwards to the socket; tests pass one that
/// collects into a `Vec`.
///
/// The two engine callbacks never fire concurrently (the pipeline invokes its
/// `FnMut` callbacks sequentially from one thread), so the shared `emit` is
/// guarded by a single-threaded `RefCell` rather than a lock.
pub fn stream_geometry(content: &[u8], emit: impl FnMut(OutMessage)) -> EngineStats {
    let emit = RefCell::new(emit);
    stream_packed_shards(
        content,
        INITIAL_BATCH_SIZE,
        THROUGHPUT_BATCH_SIZE,
        |shard| (emit.borrow_mut())(OutMessage::Shard(shard)),
        |updates| (emit.borrow_mut())(OutMessage::Control(color_update_json(updates))),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn done_json_uses_camel_case_and_carries_stats() {
        let stats = EngineStats {
            total_meshes: 3,
            total_vertices: 12,
            total_triangles: 4,
            parse_time_ms: 7,
            geometry_time_ms: 9,
            total_time_ms: 16,
            ..EngineStats::default()
        };
        let json = done_json(&stats);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["type"], "done");
        assert_eq!(v["stats"]["totalMeshes"], 3);
        assert_eq!(v["stats"]["totalTriangles"], 4);
        assert_eq!(v["stats"]["parseTimeMs"], 7);
        assert_eq!(v["stats"]["geometryTimeMs"], 9);
        assert_eq!(v["stats"]["totalTimeMs"], 16);
    }

    #[test]
    fn color_update_json_is_pairs_of_id_and_rgba() {
        let json = color_update_json(&[(42, [1.0, 0.0, 0.5, 1.0]), (7, [0.0, 0.0, 0.0, 0.25])]);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["type"], "colorUpdate");
        assert_eq!(v["updates"][0][0], 42);
        assert_eq!(v["updates"][0][1][2], 0.5);
        assert_eq!(v["updates"][1][0], 7);
        assert_eq!(v["updates"][1][1][3], 0.25);
    }

    #[test]
    fn error_json_is_tagged() {
        let v: serde_json::Value = serde_json::from_str(&error_json("bad file")).unwrap();
        assert_eq!(v["type"], "error");
        assert_eq!(v["message"], "bad file");
    }

    #[test]
    fn empty_input_streams_no_shards_and_completes() {
        // Garbage / empty content must not panic; the engine yields zero meshes
        // and we still get clean stats (the WS handler then sends `done`).
        let mut messages = Vec::new();
        let stats = stream_geometry(b"not an ifc file", |m| messages.push(m));
        assert_eq!(stats.total_meshes, 0);
        assert!(messages.iter().all(|m| matches!(m, OutMessage::Control(_))
            || matches!(m, OutMessage::Shard(_))));
    }
}
