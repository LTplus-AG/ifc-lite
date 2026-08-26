// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The geometry Parquet WIRE SCHEMA — the three tables the standard transport
//! emits, in one place.
//!
//! Split out of `parquet.rs` so the contract each client decodes against is
//! readable on its own (and so the serializer stays under its module-size
//! budget). Any column added or removed here is a wire-format change: keep it
//! additive and backward-compatible, and pin it with a test in
//! `parquet_tests.rs` — silently dropping a column is exactly how the per-mesh
//! `origin` went missing in issue #1841.

use arrow::datatypes::{DataType, Field, Schema};
use std::sync::Arc;

pub(super) fn mesh_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("express_id", DataType::UInt32, false),
        Field::new("ifc_type", DataType::Utf8, false),
        Field::new("vertex_start", DataType::UInt32, false),
        Field::new("vertex_count", DataType::UInt32, false),
        Field::new("index_start", DataType::UInt32, false),
        Field::new("index_count", DataType::UInt32, false),
        Field::new("color_r", DataType::Float32, false),
        Field::new("color_g", DataType::Float32, false),
        Field::new("color_b", DataType::Float32, false),
        Field::new("color_a", DataType::Float32, false),
        // Per-mesh local-frame origin, in the SAME Y-up metres frame as the
        // emitted positions (world vertex = origin + position). Carries the
        // canonical `MeshData.origin` the geometry pipeline already computes so
        // the client renders origin-relative geometry in the correct place
        // instead of collapsing every mesh onto the world origin (issue #1841).
        // Zero for world-baked meshes (the current native default), so this is
        // byte-neutral for those payloads.
        Field::new("origin_x", DataType::Float64, false),
        Field::new("origin_y", DataType::Float64, false),
        Field::new("origin_z", DataType::Float64, false),
        // Canonical geometry provenance (0 = occurrence, 1 = orphan type map,
        // 2 = instanced type-library template). The viewer must NOT draw class 2
        // in the normal view; without this column server meshes all decode as
        // class 0 and instanced type templates render as duplicate overlapping
        // geometry (issue #1841).
        Field::new("geometry_class", DataType::UInt8, false),
        // The two DISJOINT source ids `MeshData` carries: `geometry_item_id` is
        // the `IfcRepresentationItem` a mesh was tessellated from, `material_id`
        // is the `IfcMaterial` whose layer it slices. Never both, never 0 --
        // the same contract the wasm, cache (v14) and JSON REST transports
        // carry. Nullable because most meshes have neither, and because a
        // present-but-zero id is the one value the contract forbids: encoding
        // "absent" as 0 would make a host believe it can drill to entity #0.
        //
        // Parquet omitted both, so drill-to-source worked over /api/v1/parse
        // and not over the binary transport, with nothing in either payload
        // saying which one you were on (#3215).
        Field::new("geometry_item_id", DataType::UInt32, true),
        Field::new("material_id", DataType::UInt32, true),
    ]))
}

pub(super) fn vertex_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("x", DataType::Float32, false),
        Field::new("y", DataType::Float32, false),
        Field::new("z", DataType::Float32, false),
        Field::new("nx", DataType::Float32, false),
        Field::new("ny", DataType::Float32, false),
        Field::new("nz", DataType::Float32, false),
    ]))
}

pub(super) fn index_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("i0", DataType::UInt32, false),
        Field::new("i1", DataType::UInt32, false),
        Field::new("i2", DataType::UInt32, false),
    ]))
}
