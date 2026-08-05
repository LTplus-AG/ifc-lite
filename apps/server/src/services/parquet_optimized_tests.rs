// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `parquet_optimized.rs`, split into this ratchet-exempt
//! sibling file to keep the production module under the module-size budget
//! (same pattern as `parquet_tests.rs`). As a child `#[cfg(test)] mod
//! optimized_tests` it retains `use super::*` access to the parent's private
//! items, so the tests moved here verbatim.

    use super::*;

    #[test]
    fn test_optimized_parquet_serialization() {
        // Create test data with some duplicate meshes
        let wall_positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0];
        let wall_normals = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
        let wall_indices = vec![0, 1, 2];
        let wall_color = [0.8, 0.8, 0.8, 1.0];

        let meshes = vec![
            // Two walls with same geometry (should be deduplicated)
            MeshData::new(
                1,
                "IfcWall".to_string(),
                wall_positions.clone(),
                wall_normals.clone(),
                wall_indices.clone(),
                wall_color,
            ),
            MeshData::new(
                2,
                "IfcWall".to_string(),
                wall_positions.clone(),
                wall_normals.clone(),
                wall_indices.clone(),
                wall_color,
            ),
            // Different geometry
            MeshData::new(
                3,
                "IfcSlab".to_string(),
                vec![0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 2.0, 2.0, 0.0, 0.0, 2.0, 0.0],
                vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
                vec![0, 1, 2, 0, 2, 3],
                [0.5, 0.5, 0.5, 1.0],
            ),
        ];

        let (data, stats) = serialize_to_parquet_optimized_with_stats(&meshes, false).unwrap();

        // Should deduplicate the two identical walls
        assert_eq!(stats.input_meshes, 3);
        assert_eq!(stats.unique_meshes, 2);
        assert_eq!(stats.unique_materials, 2);
        assert!(stats.mesh_reuse_ratio > 1.0);

        // Should be very compact. Parquet has fixed per-column overhead, so
        // tiny fixtures are dominated by it — the per-instance placement columns
        // (origin_x/y/z + geometry_class, issue #1841) add four columns' worth of
        // that fixed overhead, so the floor here is generous on purpose.
        assert!(
            data.len() < 8000,
            "Expected compact output, got {} bytes",
            data.len()
        );
    }

    /// Contract test for issue #1841: the instance table MUST carry a
    /// per-instance `origin` (Y-up) and `geometry_class`. Deduplication merges
    /// bit-identical template geometry, so the ONLY thing that places a repeated
    /// occurrence is its origin — dropping it collapses "N slabs into one slab"
    /// at the template coordinates. Two identical slabs at different origins must
    /// dedup to one mesh yet keep two distinct origins.
    #[test]
    fn instance_table_carries_origin_and_geometry_class() {
        use arrow::array::{Float64Array, UInt8Array};
        use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

        let slab = |id: u32, ifc_origin: [f64; 3]| {
            MeshData::new(
                id,
                "IfcSlab".to_string(),
                vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0],
                vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
                vec![0, 1, 2],
                [0.5, 0.5, 0.5, 1.0],
            )
            .with_origin(ifc_origin)
        };
        // Same shape, two different placements → must dedup to ONE template.
        let meshes = vec![
            slab(1, [0.0, 0.0, 0.0]),
            slab(2, [10.0, 20.0, 3.0]),
        ];

        let (data, stats) = serialize_to_parquet_optimized_with_stats(&meshes, false).unwrap();
        assert_eq!(stats.unique_meshes, 1, "identical shapes must deduplicate");

        // Unframe: [version:u8][flags:u8][instance_len:u32][...4 more lens][instance_parquet]...
        let instance_len = u32::from_le_bytes(data[2..6].try_into().unwrap()) as usize;
        let header = 2 + 5 * 4;
        let instance_bytes = Bytes::copy_from_slice(&data[header..header + instance_len]);
        let reader = ParquetRecordBatchReaderBuilder::try_new(instance_bytes)
            .unwrap()
            .build()
            .unwrap();
        let batch = reader.map(|b| b.unwrap()).next().unwrap();

        let col = |name: &str| batch.schema().index_of(name).expect(name);
        let oy = batch
            .column(col("origin_y"))
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        let oz = batch
            .column(col("origin_z"))
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        // geometry_class column must exist even when all-zero.
        let _ = batch
            .column(col("geometry_class"))
            .as_any()
            .downcast_ref::<UInt8Array>()
            .unwrap();

        assert_eq!(batch.num_rows(), 2, "both occurrences kept as instances");
        // Instance 1: origin [10,20,3] IFC Z-up → Y-up [x, z, -y] = [10, 3, -20].
        assert_eq!(oy.value(1), 3.0);
        assert_eq!(oz.value(1), -20.0);
    }

    /// Mesh-table `vertex_offset`/`index_offset` (both `u32`, adjacent in the
    /// per-mesh push order) must carry the ACTUAL per-mesh offsets, not just
    /// decode as "some" table — nothing previously read this table at all.
    /// Uses two DISTINCT (non-deduplicated) meshes with different vertex vs.
    /// triangle counts so a vertex_offset/index_offset swap changes a value,
    /// not just a row count.
    #[test]
    fn mesh_table_offsets_and_counts_match_actual_mesh_sizes() {
        use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

        // Mesh 1: 4 vertices, 3 indices (1 triangle).
        let mesh1 = MeshData::new(
            1,
            "IfcWall".to_string(),
            vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0],
            vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
            vec![0, 1, 2],
            [0.1, 0.2, 0.3, 1.0],
        );
        // Mesh 2: different geometry (won't dedup), 3 vertices, 12 indices (4 triangles).
        let mesh2 = MeshData::new(
            2,
            "IfcSlab".to_string(),
            vec![5.0, 0.0, 0.0, 6.0, 0.0, 0.0, 6.0, 6.0, 0.0],
            vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
            vec![0, 1, 2, 0, 2, 1, 0, 1, 2, 0, 2, 1],
            [0.4, 0.5, 0.6, 1.0],
        );

        let (data, stats) =
            serialize_to_parquet_optimized_with_stats(&[mesh1, mesh2], false).unwrap();
        assert_eq!(stats.unique_meshes, 2, "distinct geometry must not dedup");

        // Unframe: [version:u8][flags:u8][instance_len][mesh_len][material_len][vertex_len][index_len][instance][mesh]...
        let instance_len = u32::from_le_bytes(data[2..6].try_into().unwrap()) as usize;
        let mesh_len = u32::from_le_bytes(data[6..10].try_into().unwrap()) as usize;
        let header = 2 + 5 * 4;
        let mesh_bytes =
            Bytes::copy_from_slice(&data[header + instance_len..header + instance_len + mesh_len]);
        let reader = ParquetRecordBatchReaderBuilder::try_new(mesh_bytes)
            .unwrap()
            .build()
            .unwrap();
        let batch = reader.map(|b| b.unwrap()).next().unwrap();

        let col = |name: &str| batch.schema().index_of(name).expect(name);
        let get = |name: &str| {
            batch
                .column(col(name))
                .as_any()
                .downcast_ref::<UInt32Array>()
                .unwrap()
                .clone()
        };
        let vertex_offset = get("vertex_offset");
        let vertex_count = get("vertex_count");
        let index_offset = get("index_offset");
        let index_count = get("index_count");

        assert_eq!(batch.num_rows(), 2);
        assert_eq!(vertex_offset.value(0), 0);
        assert_eq!(vertex_count.value(0), 4);
        assert_eq!(index_offset.value(0), 0);
        assert_eq!(index_count.value(0), 3);
        // Mesh 2's vertex_offset (4, after mesh 1's 4 verts) must differ from
        // its index_offset (3, after mesh 1's 3 indices) — a swap would flip these.
        assert_eq!(vertex_offset.value(1), 4);
        assert_eq!(vertex_count.value(1), 3);
        assert_eq!(index_offset.value(1), 3);
        assert_eq!(index_count.value(1), 12);
    }

    #[test]
    fn test_quantization() {
        assert_eq!(quantize_position(1.0), 10_000);
        assert_eq!(quantize_position(0.0001), 1); // 0.1mm
        assert_eq!(quantize_position(-1.5), -15_000);
    }

    #[test]
    fn test_color_to_byte() {
        assert_eq!(color_to_byte(0.0), 0);
        assert_eq!(color_to_byte(1.0), 255);
        assert_eq!(color_to_byte(0.5), 128);
    }

    /// Regression test for #586: meshes with positions but no normals
    /// (e.g. `advanced_brep.ifc`) used to panic when `include_normals = true`.
    #[test]
    fn test_optimized_serialize_mesh_without_normals() {
        let meshes = vec![MeshData::new(
            42,
            "IfcAdvancedBrep".to_string(),
            vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0],
            Vec::new(),
            vec![0, 1, 2],
            [0.8, 0.8, 0.8, 1.0],
        )];

        // Both code paths must survive empty normals.
        assert!(serialize_to_parquet_optimized_with_stats(&meshes, false).is_ok());
        assert!(serialize_to_parquet_optimized_with_stats(&meshes, true).is_ok());
    }
