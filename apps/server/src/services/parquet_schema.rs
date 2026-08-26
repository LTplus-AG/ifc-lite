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

/// Absent marker for the two source ids. Mirrors `ABSENT_SOURCE_ID` in
/// `packages/cache/src/sections/geometry.ts`.
///
/// A REAL collision, taken deliberately: `#4294967295` is a legal instance name
/// (`fast_parse_tests.rs:57` asserts u32::MAX parses; `step_tests.rs:436`
/// writes one), so a mesh sourced from exactly that id loses its drill target.
/// The alternatives are worse: `0` is reachable, a nullable column leaks the
/// neighbouring row's id on parquet-wasm 0.7.x, and presence columns cost two
/// per row to disambiguate one value in 4.29 billion.
pub(super) const ABSENT_SOURCE_ID: u32 = 0xFFFF_FFFF;
use std::sync::Arc;

pub(super) fn mesh_schema() -> Arc<Schema> {
    Arc::new(Schema::new(
        vec![
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
        ]
        .into_iter()
        .chain(shared_trailing_fields())
        .collect::<Vec<_>>(),
    ))
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

/// One mesh's row across the three tables, in the order `mesh_schema()` lists.
///
/// A struct, not the 11-element tuple this was. That tuple was POSITIONAL and
/// several slots share a type -- the four `u32` offsets/counts, and the two
/// `Option<u32>` source ids. Measured BEFORE this branch grew its tests:
/// swapping the two ids compiled and left 202/202 green, writing every
/// representation-item id into the material column and back.
///
/// It is caught now -- `mesh_table_carries_both_source_ids_on_the_right_columns`
/// fails on that swap. Named fields make it unreachable at the construction
/// site as well, which is belt and braces, not a reason to drop the test: the
/// RecordBatch arrays are still positional against the schema.
pub(super) struct MeshRow<'a> {
    pub express_id: u32,
    pub ifc_type: &'a str,
    pub v_start: u32,
    pub vert_count: u32,
    pub i_start: u32,
    pub index_count: u32,
    pub color: [f32; 4],
    /// In the SAME Y-up frame as the emitted positions. The swap is linear, so
    /// swap(origin + position) = swap(origin) + swap(position); see
    /// `services::axis` for the one definition.
    pub origin: [f64; 3],
    pub geometry_class: u8,
    pub geometry_item_id: Option<u32>,
    pub material_id: Option<u32>,
}

impl<'a> MeshRow<'a> {
    /// Build one row from a mesh and its precomputed buffer offsets.
    ///
    /// Here rather than at the call site so the field order is stated once,
    /// next to the schema whose column order it feeds.
    pub fn new(mesh: &'a crate::types::MeshData, v_start: u32, i_start: u32) -> Self {
        Self {
            express_id: mesh.express_id,
            ifc_type: mesh.ifc_type.as_str(),
            v_start,
            vert_count: (mesh.positions.len() / 3) as u32,
            i_start,
            index_count: mesh.indices.len() as u32,
            color: mesh.color,
            origin: crate::services::axis::zup_to_yup_f64(mesh.origin),
            geometry_class: mesh.geometry_class,
            geometry_item_id: mesh.geometry_item_id,
            material_id: mesh.material_id,
        }
    }
}

/// The trailing per-mesh columns both transports carry, in order.
///
/// A FUNCTION both schemas call, not a list a test compares them against.
/// `mesh_schema()` and the inline instance schema in `parquet_optimized.rs`
/// were kept in step by hand and that does not hold: `benches/serialization.rs`
/// is a third copy and has already drifted, missing `origin_x/y/z` and
/// `geometry_class` long before #3215. Adding a column to one and not the other
/// compiles and leaves every test green -- the TS decoder resolves by name, so
/// the transport that lost it just omits it forever.
///
/// Sharing the constructor removes the drift rather than detecting it. The
/// LEADING columns still differ legitimately (`express_id` vs `entity_id`), so
/// only this tail is shared.
pub(super) fn shared_trailing_fields() -> Vec<Field> {
    vec![
        // Per-mesh local-frame origin, in the SAME Y-up metres frame as the
        // emitted positions (world vertex = origin + position). Zero for
        // world-baked meshes (issue #1841).
        Field::new("origin_x", DataType::Float64, false),
        Field::new("origin_y", DataType::Float64, false),
        Field::new("origin_z", DataType::Float64, false),
        // Canonical geometry provenance (0 = occurrence, 1 = orphan type map,
        // 2 = instanced type-library template). The viewer must NOT draw class
        // 2 in the normal view (issue #1841).
        Field::new("geometry_class", DataType::UInt8, false),
        // The two DISJOINT source ids `MeshData` carries: `geometry_item_id` is
        // the `IfcRepresentationItem` a mesh was tessellated from, `material_id`
        // the `IfcMaterial` whose layer it slices. Never both. Parquet omitted
        // both, so drill-to-source worked over /api/v1/parse and not over the
        // binary transport (#3215).
        //
        // NOT NULLABLE, with an explicit ABSENT_SOURCE_ID sentinel -- the same
        // choice `packages/cache/src/sections/geometry.ts` made at v14, for a
        // sharper reason than tidiness. A nullable UInt32's values buffer is
        // undefined at null rows, and parquet-wasm 0.7.x leaks the NEIGHBOURING
        // row's value into it: a mesh with no material decoded as
        // `material_id: 902`, a real-looking id for a different entity.
        // `apps/viewer` and `packages/export` already pin ^0.7.2 while
        // server-client's peer range is >=0.5.0, so that reader is in the tree.
        // A sentinel in a non-nullable column has no validity bitmap to leak.
        //
        // 0xFFFFFFFF and not 0: `MeshData::with_style_metadata` already filters
        // 0 to None (an OPTIONAL `IfcMaterialLayer.Material` arrives as 0), and
        // an absence marker the domain can produce is one change from wrong.
        Field::new("geometry_item_id", DataType::UInt32, false),
        Field::new("material_id", DataType::UInt32, false),
    ]
}

/// The optimized transport's instance table.
///
/// Lives here, beside `mesh_schema()`, because the two share their trailing
/// block and differ only in the leading identity columns (`entity_id` vs
/// `express_id`). It was inline in `parquet_optimized.rs`, which is how the
/// pair drifted by hand in the first place.
pub(super) fn instance_schema() -> Arc<Schema> {
    Arc::new(Schema::new(
        vec![
            Field::new("entity_id", DataType::UInt32, false),
            Field::new("ifc_type", DataType::Utf8, false),
            Field::new("mesh_index", DataType::UInt32, false),
            Field::new("material_index", DataType::UInt32, false),
        ]
        .into_iter()
        .chain(shared_trailing_fields())
        .collect::<Vec<_>>(),
    ))
}
