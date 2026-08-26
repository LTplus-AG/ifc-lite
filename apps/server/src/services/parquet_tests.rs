// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `parquet.rs`, split into this ratchet-exempt sibling file
//! to keep the production module under the module-size budget. As a child
//! `#[cfg(test)] mod parquet_tests` it retains `use super::*` access to the
//! parent module's private items, so the tests moved here verbatim.

    use super::*;
    use crate::services::parquet_schema::ABSENT_SOURCE_ID;

    #[test]
    fn test_parquet_serialization() {
        let meshes = vec![
            MeshData::new(
                1,
                "IfcWall".to_string(),
                vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0],
                vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
                vec![0, 1, 2],
                [0.8, 0.8, 0.8, 1.0],
            ),
            MeshData::new(
                2,
                "IfcSlab".to_string(),
                vec![0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 2.0, 2.0, 0.0, 0.0, 2.0, 0.0],
                vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
                vec![0, 1, 2, 0, 2, 3],
                [0.5, 0.5, 0.5, 1.0],
            ),
        ];

        let result = serialize_to_parquet(&meshes);
        assert!(result.is_ok());

        let data = result.unwrap();
        // Should be much smaller than JSON equivalent
        // Note: Parquet has fixed overhead (~4KB headers), so small test data may appear larger
        // Real-world compression is 15x+ on actual IFC geometry data
        assert!(
            data.len() < 10000,
            "Expected compact output, got {} bytes",
            data.len()
        );
    }

    /// Decode one framed section blob back into its three tables.
    fn read_sections(blob: &[u8]) -> Vec<Vec<RecordBatch>> {
        use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
        let mut out = Vec::new();
        let mut off = 0usize;
        for _ in 0..3 {
            let len = u32::from_le_bytes(blob[off..off + 4].try_into().unwrap()) as usize;
            off += 4;
            let section = Bytes::copy_from_slice(&blob[off..off + len]);
            off += len;
            let reader = ParquetRecordBatchReaderBuilder::try_new(section)
                .unwrap()
                .build()
                .unwrap();
            out.push(reader.map(|b| b.unwrap()).collect::<Vec<_>>());
        }
        assert_eq!(off, blob.len(), "trailing bytes after the three sections");
        out
    }

    /// Concatenate row groups per column into one comparable table.
    fn concat_all(batches: &[RecordBatch]) -> RecordBatch {
        let schema = batches[0].schema();
        arrow::compute::concat_batches(&schema, batches).unwrap()
    }

    /// The incremental cache writer must produce a blob DECODE-equivalent to
    /// the one-shot serializer for the same meshes: same schemas, same rows,
    /// same GLOBAL vertex/index offsets - only the row-group layout differs.
    #[test]
    fn incremental_writer_matches_one_shot_serializer() {
        let mesh = |id: u32, verts: usize| {
            let mut positions = Vec::new();
            for v in 0..verts {
                positions.extend_from_slice(&[v as f32, id as f32, 0.5 * v as f32]);
            }
            let normals = vec![0.0; verts * 3];
            let indices: Vec<u32> = (0..(verts as u32 / 3) * 3).collect();
            MeshData::new(id, format!("IfcThing{id}"), positions, normals, indices, [0.1, 0.2, 0.3, 1.0])
        };
        let meshes: Vec<MeshData> = (1..=7).map(|i| mesh(i, 3 * i as usize)).collect();

        let one_shot = serialize_to_parquet(&meshes).unwrap();

        let mut writer = StreamingParquetCacheWriter::new().unwrap();
        // Uneven batches on purpose: 2 + 4 + 1.
        writer.append(&meshes[0..2]).unwrap();
        writer.append(&meshes[2..6]).unwrap();
        writer.append(&meshes[6..7]).unwrap();
        assert_eq!(writer.mesh_count(), 7);
        let incremental = writer.finish().unwrap();

        let a = read_sections(&one_shot);
        let b = read_sections(&incremental);
        for (section_a, section_b) in a.iter().zip(b.iter()) {
            let ta = concat_all(section_a);
            let tb = concat_all(section_b);
            assert_eq!(ta.schema(), tb.schema());
            assert_eq!(ta.num_rows(), tb.num_rows());
            assert_eq!(ta, tb, "decoded tables must be identical (incl. global offsets)");
        }
    }

    /// `finish_combined()` must byte-equal the old two-copy path (wrap
    /// `finish()`'s inner blob with `[geo_len][geo_bytes][dm_len=0]` in a
    /// second Vec, as the parquet-stream route used to do inline) and the
    /// result must parse back to the same tables as the one-shot serializer.
    /// This is a copy-elimination, not a format change; a byte mismatch here
    /// means the wire format drifted.
    #[test]
    fn finish_combined_matches_old_two_copy_wrapping() {
        let mesh = |id: u32, verts: usize| {
            let mut positions = Vec::new();
            for v in 0..verts {
                positions.extend_from_slice(&[v as f32, id as f32, 0.5 * v as f32]);
            }
            let normals = vec![0.0; verts * 3];
            let indices: Vec<u32> = (0..(verts as u32 / 3) * 3).collect();
            MeshData::new(id, format!("IfcThing{id}"), positions, normals, indices, [0.1, 0.2, 0.3, 1.0])
        };
        let meshes: Vec<MeshData> = (1..=5).map(|i| mesh(i, 3 * i as usize)).collect();

        // Old path: finish() the inner geometry blob, then wrap it a second
        // time exactly like the route used to (before finish_combined()).
        let mut writer_old = StreamingParquetCacheWriter::new().unwrap();
        writer_old.append(&meshes[0..2]).unwrap();
        writer_old.append(&meshes[2..5]).unwrap();
        let geometry_parquet = writer_old.finish().unwrap();
        let mut old_combined = Vec::new();
        old_combined.extend_from_slice(&(geometry_parquet.len() as u32).to_le_bytes());
        old_combined.extend_from_slice(&geometry_parquet);
        old_combined.extend_from_slice(&0u32.to_le_bytes());

        // New path: finish_combined() builds the same outer framing in one pass.
        let mut writer_new = StreamingParquetCacheWriter::new().unwrap();
        writer_new.append(&meshes[0..2]).unwrap();
        writer_new.append(&meshes[2..5]).unwrap();
        let new_combined = writer_new.finish_combined().unwrap();

        assert_eq!(
            old_combined.as_slice(),
            new_combined.as_ref(),
            "finish_combined() must be byte-identical to the old two-copy wrapping"
        );

        // Round-trip: unwrap the outer framing and confirm the inner geometry
        // blob decodes to the same tables as the one-shot serializer.
        let geo_len = u32::from_le_bytes(new_combined[0..4].try_into().unwrap()) as usize;
        let dm_len_offset = 4 + geo_len;
        let dm_len =
            u32::from_le_bytes(new_combined[dm_len_offset..dm_len_offset + 4].try_into().unwrap());
        assert_eq!(dm_len, 0, "streamed cache fill never attaches a data model inline");
        assert_eq!(new_combined.len(), 4 + geo_len + 4, "no trailing bytes after the outer frame");

        let inner_geo = &new_combined[4..4 + geo_len];
        let one_shot = serialize_to_parquet(&meshes).unwrap();
        let a = read_sections(&one_shot);
        let b = read_sections(inner_geo);
        for (section_a, section_b) in a.iter().zip(b.iter()) {
            let ta = concat_all(section_a);
            let tb = concat_all(section_b);
            assert_eq!(ta.schema(), tb.schema());
            assert_eq!(ta, tb, "decoded tables must match the one-shot serializer");
        }
    }

    /// Regression + contract test for issue #1841: the mesh table MUST carry
    /// the per-mesh `origin` (Y-up, world = origin + position) and
    /// `geometry_class`. Dropping either silently collapses origin-relative
    /// geometry onto the world origin / renders instanced type templates as
    /// duplicates. This pins that the columns exist, in the canonical frame.
    #[test]
    fn mesh_table_carries_origin_and_geometry_class() {
        use arrow::array::{Float64Array, UInt8Array};

        // A slab whose vertices are stored RELATIVE to a building-scale origin.
        // origin is in IFC Z-up; the wire must emit it Z-up→Y-up swapped so it
        // matches the swapped positions: [x, z, -y].
        let ifc_origin = [1000.0_f64, 2000.0, 30.0];
        let mesh = MeshData::new(
            7,
            "IfcSlab".to_string(),
            vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0],
            vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
            vec![0, 1, 2],
            [0.5, 0.5, 0.5, 1.0],
        )
        .with_origin(ifc_origin)
        .with_geometry_class(2);

        let blob = serialize_to_parquet(&[mesh]).unwrap();
        let sections = read_sections(&blob);
        let mesh_table = concat_all(&sections[0]);

        let col = |name: &str| mesh_table.schema().index_of(name).expect(name);
        let ox = mesh_table
            .column(col("origin_x"))
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        let oy = mesh_table
            .column(col("origin_y"))
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        let oz = mesh_table
            .column(col("origin_z"))
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        let gc = mesh_table
            .column(col("geometry_class"))
            .as_any()
            .downcast_ref::<UInt8Array>()
            .unwrap();

        // Z-up→Y-up: x stays, y = old z, z = -old y.
        assert_eq!(ox.value(0), 1000.0);
        assert_eq!(oy.value(0), 30.0);
        assert_eq!(oz.value(0), -2000.0);
        assert_eq!(gc.value(0), 2);
    }

    /// Both transports must end with the same per-mesh column block.
    ///
    /// Both now COMPOSE `shared_trailing_fields()`, so the columns cannot drift
    /// apart by editing one literal -- that is structural, not tested. What
    /// this guards is the composition itself: dropping the `.chain(...)` from
    /// one schema still compiles and would silently shorten that transport.
    ///
    /// Worth having because the hand-kept version genuinely failed:
    /// `benches/serialization.rs` is a third copy that has already drifted,
    /// missing `origin_x/y/z` and `geometry_class`.
    #[test]
    fn both_mesh_schemas_end_with_the_same_shared_columns() {
        use crate::services::parquet_schema::shared_trailing_fields;

        let shared: Vec<String> = shared_trailing_fields()
            .iter()
            .map(|f| f.name().clone())
            .collect();
        // Anti-vacuity: an empty tail would make every assertion below pass.
        assert!(shared.len() >= 6, "expected the full shared block, got {shared:?}");

        let standard: Vec<String> = mesh_schema()
            .fields()
            .iter()
            .map(|f| f.name().clone())
            .collect();

        // Reach the instance schema through a real serialization rather than
        // re-declaring it -- a re-declaration would be another copy and would
        // pass while the real one drifted.
        let mesh = MeshData::new(
            1,
            "IfcWall".to_string(),
            vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0],
            vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
            vec![0, 1, 2],
            [0.5, 0.5, 0.5, 1.0],
        );
        use crate::services::parquet_optimized::serialize_to_parquet_optimized;
        let blob = serialize_to_parquet_optimized(&[mesh], false).expect("optimized serialize");
        // The optimized blob has its OWN framing --
        // [version:u8][flags:u8][5 x len:u32][instance_parquet]... -- not the
        // section layout `read_sections` expects. Using the wrong reader here
        // read a length of 175570950 out of a 6140-byte buffer, which looked
        // like schema drift until I read the framing.
        let instance_len = u32::from_le_bytes(blob[2..6].try_into().unwrap()) as usize;
        let header = 2 + 5 * 4;
        let instance_bytes = bytes::Bytes::copy_from_slice(&blob[header..header + instance_len]);
        use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
        let reader = ParquetRecordBatchReaderBuilder::try_new(instance_bytes)
            .unwrap()
            .build()
            .unwrap();
        let instance: Vec<String> = reader
            .map(|b| b.unwrap())
            .next()
            .unwrap()
            .schema()
            .fields()
            .iter()
            .map(|f| f.name().clone())
            .collect();

        let tail = |cols: &[String]| -> Vec<String> { cols[cols.len() - shared.len()..].to_vec() };
        assert_eq!(
            tail(&standard),
            shared,
            "mesh_schema() stopped composing shared_trailing_fields()"
        );
        assert_eq!(
            tail(&instance),
            shared,
            "the optimized instance schema stopped composing shared_trailing_fields()"
        );
    }

    /// The two source ids must reach the wire on the RIGHT columns, with the
    /// absent marker where a mesh has neither (#3215).
    ///
    /// The writer had no Rust test at all, and the two ids were adjacent
    /// `Option<u32>` slots in the metadata tuple this file already warns about
    /// for `vertex_start`/`index_start`. Measured then: swapping them compiled
    /// and left 202/202 green — every representation-item id written into the
    /// material column and back, the wrong-entity drill target #3199 removed.
    /// That tuple is a `MeshRow` struct now, but the RecordBatch arrays are
    /// still positional against the schema, so this still earns its place.
    ///
    /// So the fixture puts a DIFFERENT id on each field and a third mesh with
    /// neither: a swap moves both values and this fails on the first assert.
    #[test]
    fn mesh_table_carries_both_source_ids_on_the_right_columns() {
        use arrow::array::UInt32Array;

        let base = |eid: u32| {
            MeshData::new(
                eid,
                "IfcWall".to_string(),
                vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0],
                vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
                vec![0, 1, 2],
                [0.5, 0.5, 0.5, 1.0],
            )
        };
        // Distinct values on the two fields, so a swap cannot pass.
        let geo = base(10).with_style_metadata(None, Some(501), false);
        let mat = base(11).with_style_metadata(None, Some(902), true);
        let neither = base(12);

        let blob = serialize_to_parquet(&[geo, mat, neither]).unwrap();
        let sections = read_sections(&blob);
        let mesh_table = concat_all(&sections[0]);
        let col = |name: &str| mesh_table.schema().index_of(name).expect(name);
        let gi = mesh_table
            .column(col("geometry_item_id"))
            .as_any()
            .downcast_ref::<UInt32Array>()
            .unwrap();
        let mi = mesh_table
            .column(col("material_id"))
            .as_any()
            .downcast_ref::<UInt32Array>()
            .unwrap();

        assert_eq!(gi.value(0), 501, "representation-item id on its own column");
        assert_eq!(mi.value(0), ABSENT_SOURCE_ID, "and NOT on the material one");
        assert_eq!(mi.value(1), 902, "material id on its own column");
        assert_eq!(gi.value(1), ABSENT_SOURCE_ID, "and NOT on the geometry one");
        assert_eq!(gi.value(2), ABSENT_SOURCE_ID);
        assert_eq!(mi.value(2), ABSENT_SOURCE_ID);

        // Non-nullable on purpose: a nullable column's values buffer is
        // undefined at null rows and parquet-wasm 0.7.x leaks the neighbouring
        // row's id into it. No nulls means nothing to leak.
        assert_eq!(mesh_table.column(col("geometry_item_id")).null_count(), 0);
        assert_eq!(mesh_table.column(col("material_id")).null_count(), 0);
    }

    /// Mesh-table offset/count columns must carry the ACTUAL per-mesh values,
    /// not just decode as "some" table. `vertex_start`/`index_start` are both
    /// `u32` and sit next to each other in `MeshRow` and in the positional
    /// RecordBatch arrays — an easy accidental swap. (They were adjacent tuple
    /// slots when this was written; #3215 made that a struct, which removes the
    /// construction-site half of the hazard but not the batch-order half.) Uses meshes with DIFFERENT vertex counts and triangle
    /// counts per mesh (4 verts/1 tri, then 3 verts/2 tris) so vertex_start and
    /// index_start can never coincide by accident, unlike same-size fixtures
    /// elsewhere in this file.
    #[test]
    fn mesh_table_offsets_and_counts_match_actual_mesh_sizes() {
        use arrow::array::UInt32Array;

        // Mesh 1: 4 vertices (a quad, but only using 3 indices to keep it simple
        // — vertex_count != index_count on purpose), 1 triangle.
        let mesh1 = MeshData::new(
            10,
            "IfcWall".to_string(),
            vec![
                0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0,
            ],
            vec![
                0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0,
            ],
            vec![0, 1, 2],
            [0.1, 0.2, 0.3, 1.0],
        );
        // Mesh 2: 3 vertices, 2 triangles (6 indices) — deliberately more
        // indices than vertices so index_start/index_count can't be confused
        // with vertex_start/vertex_count by magnitude alone.
        let mesh2 = MeshData::new(
            20,
            "IfcSlab".to_string(),
            vec![0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 2.0, 2.0, 0.0],
            vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
            vec![0, 1, 2, 0, 2, 1, 0, 1, 2, 0, 2, 1],
            [0.4, 0.5, 0.6, 1.0],
        );

        let blob = serialize_to_parquet(&[mesh1, mesh2]).unwrap();
        let sections = read_sections(&blob);
        let mesh_table = concat_all(&sections[0]);

        let col = |name: &str| mesh_table.schema().index_of(name).expect(name);
        let get = |name: &str| {
            mesh_table
                .column(col(name))
                .as_any()
                .downcast_ref::<UInt32Array>()
                .unwrap()
                .clone()
        };
        let vertex_start = get("vertex_start");
        let vertex_count = get("vertex_count");
        let index_start = get("index_start");
        let index_count = get("index_count");

        assert_eq!(mesh_table.num_rows(), 2);
        // Mesh 1 (row 0): 4 vertices at offset 0, 3 indices at offset 0.
        assert_eq!(vertex_start.value(0), 0);
        assert_eq!(vertex_count.value(0), 4);
        assert_eq!(index_start.value(0), 0);
        assert_eq!(index_count.value(0), 3);
        // Mesh 2 (row 1): 3 vertices starting AFTER mesh 1's 4 (offset 4), 12
        // indices starting AFTER mesh 1's 3 (offset 3). If vertex_start and
        // index_start were swapped, row 1 would show vertex_start=3 instead of 4.
        assert_eq!(vertex_start.value(1), 4);
        assert_eq!(vertex_count.value(1), 3);
        assert_eq!(index_start.value(1), 3);
        assert_eq!(index_count.value(1), 12);
    }

    /// Regression test for #586: meshes with positions but no normals
    /// (e.g. `advanced_brep.ifc`) used to panic with "index out of bounds"
    /// inside the rayon worker, taking down the server process.
    #[test]
    fn test_serialize_mesh_without_normals() {
        let meshes = vec![MeshData::new(
            42,
            "IfcAdvancedBrep".to_string(),
            vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0],
            Vec::new(), // no normals — must not panic
            vec![0, 1, 2],
            [0.8, 0.8, 0.8, 1.0],
        )];

        let result = serialize_to_parquet(&meshes);
        assert!(
            result.is_ok(),
            "serialize_to_parquet should not panic on empty normals: {:?}",
            result.err()
        );
    }
