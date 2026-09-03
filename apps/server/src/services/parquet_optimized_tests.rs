// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `parquet_optimized.rs`, split into this ratchet-exempt
//! sibling file to keep the production module under the module-size budget
//! (same pattern as `parquet_tests.rs`). As a child `#[cfg(test)] mod
//! optimized_tests` it retains `use super::*` access to the parent's private
//! items, so the tests moved here verbatim.

    use super::*;
    use crate::services::parquet_schema::ABSENT_SOURCE_ID;

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

        // No mesh here carries `InstanceMeta`, so no rotation-aware placement is
        // produced and the payload is v2-shaped (see the two-direction pair
        // `translation_only_reuse_ships_wire_version_2` /
        // `rotated_mapped_item_repeats_dedup_and_reconstruct_correctly`).
        assert_eq!(data[0], 2, "a payload with no rotation data must stay wire version 2");

        // Should be very compact. Parquet has fixed per-column overhead, so
        // tiny fixtures are dominated by it — the per-instance placement columns
        // (origin_x/y/z + geometry_class, issue #1841) add four columns' worth of
        // that fixed overhead, and the nine rotation columns (issue #3575) add
        // nine more, so the floor here is generous on purpose.
        assert!(
            data.len() < 9000,
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
    /// The optimized transport must put each id on its OWN column, and must not
    /// confuse `material_id` with `material_index` (#3215).
    ///
    /// The standard transport has this assertion; this one had none — grepping
    /// this file for `material_id`, `geometry_item_id` or `material_index`
    /// returned zero. The only marker of the hazard was a comment, and I
    /// deleted it compressing that file under its size budget.
    ///
    /// The hazard is concrete: `instance_material_indices` and
    /// `instance_material_ids` are both `Vec<u32>`, their columns sit five
    /// apart in the same batch, and swapping them compiles. `material_index`
    /// indexes this file's own material table; `material_id` is an
    /// `IfcMaterial` express id. Same word, different spaces.
    #[test]
    fn instance_table_keeps_source_ids_and_material_index_apart() {
        use arrow::array::UInt32Array;
        use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

        let base = |eid: u32, x: f32| {
            MeshData::new(
                eid,
                "IfcWall".to_string(),
                vec![x, 0.0, 0.0, x + 1.0, 0.0, 0.0, x + 1.0, 1.0, 0.0],
                vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
                vec![0, 1, 2],
                [0.5, 0.5, 0.5, 1.0],
            )
        };
        // Distinct values on the two fields so a swap cannot pass, and a third
        // instance with neither.
        let geo = base(10, 0.0).with_style_metadata(None, Some(501), false);
        let mat = base(11, 5.0).with_style_metadata(None, Some(902), true);
        let neither = base(12, 9.0);

        let (data, _) =
            serialize_to_parquet_optimized_with_stats(&[geo, mat, neither], false).unwrap();
        let instance_len = u32::from_le_bytes(data[2..6].try_into().unwrap()) as usize;
        let header = 2 + 5 * 4;
        let instance_bytes = Bytes::copy_from_slice(&data[header..header + instance_len]);
        let batch = ParquetRecordBatchReaderBuilder::try_new(instance_bytes)
            .unwrap()
            .build()
            .unwrap()
            .map(|b| b.unwrap())
            .next()
            .unwrap();

        let col = |name: &str| batch.schema().index_of(name).expect(name);
        let u32col = |name: &str| {
            batch
                .column(col(name))
                .as_any()
                .downcast_ref::<UInt32Array>()
                .unwrap()
                .clone()
        };
        let gi = u32col("geometry_item_id");
        let mi = u32col("material_id");
        let mx = u32col("material_index");

        assert_eq!(gi.value(0), 501, "representation-item id on its own column");
        assert_eq!(mi.value(0), ABSENT_SOURCE_ID, "and NOT on the material one");
        assert_eq!(mi.value(1), 902, "material id on its own column");
        assert_eq!(gi.value(1), ABSENT_SOURCE_ID, "and NOT on the geometry one");
        assert_eq!(gi.value(2), ABSENT_SOURCE_ID);
        assert_eq!(mi.value(2), ABSENT_SOURCE_ID);

        // material_index is a table offset, never an express id: all three
        // meshes share one colour, so it is 0 everywhere while material_id is
        // not. That difference is what a swap would destroy.
        for i in 0..3 {
            assert_eq!(mx.value(i), 0, "material_index is an offset into this file");
        }
    }

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

    /// `assemble_optimized_output`'s five section lengths are wire-format
    /// u32 (see the doc comment on the function). Coverage-gap-turned-fix:
    /// `serialize_to_parquet_optimized` built these five `[len:u32][bytes]`
    /// sections by casting `usize` to `u32` with no bounds check — unlike
    /// `parquet::frame_sections`/`frame_combined_sections`, which already
    /// call `check_u32_len` for the exact same wire shape. A section over
    /// 4 GiB would have its length prefix silently wrap instead of erroring,
    /// producing a blob whose declared length disagrees with its actual
    /// bytes.
    ///
    /// Proven directly against `check_optimized_section_lengths` using bare
    /// `usize` lengths — no multi-gigabyte Arrow/Parquet encode, and no
    /// multi-gigabyte `Vec` allocation either. An earlier version of this
    /// test allocated a real `vec![0u8; u32::MAX as usize + 1]` per slot to
    /// drive `assemble_optimized_output` end to end; that reserves >4 GiB of
    /// (lazily-zeroed) address space five times over on every test run,
    /// which is wasteful and, on a memory-constrained runner, risks an OOM
    /// kill that would look nothing like the guard actually failing.
    #[test]
    fn each_section_length_is_checked_against_the_u32_wire_limit() {
        let oversized_len = (u32::MAX as usize) + 1;
        let section_names = ["instance", "mesh", "material", "vertex", "index"];

        for oversized_slot in 0..section_names.len() {
            let mut lengths = [4usize; 5];
            lengths[oversized_slot] = oversized_len;

            let result = check_optimized_section_lengths(
                lengths[0], lengths[1], lengths[2], lengths[3], lengths[4],
            );
            assert!(
                result.is_err(),
                "{} section of {oversized_len} bytes (> u32::MAX) must be rejected, not silently wrapped into a corrupt length prefix",
                section_names[oversized_slot]
            );
        }
    }

    /// Bounding control for the test above: all-small lengths must pass, so
    /// the assertion can't be vacuously true from an always-erroring guard.
    #[test]
    fn all_small_section_lengths_pass_the_u32_wire_check() {
        assert!(check_optimized_section_lengths(4, 4, 4, 4, 4).is_ok());
    }

    /// Row-major mat4 (Z-up, `InstanceMeta::transform` convention): rotate
    /// `deg` about Z, then translate by `t`.
    fn rot_z_mat4(deg: f64, t: [f64; 3]) -> [f64; 16] {
        let rad = deg.to_radians();
        let (s, c) = (rad.sin(), rad.cos());
        #[rustfmt::skip]
        let m = [
            c,  -s, 0.0, t[0],
            s,   c, 0.0, t[1],
            0.0, 0.0, 1.0, t[2],
            0.0, 0.0, 0.0, 1.0,
        ];
        m
    }

    /// Bake a canonical (source-coords) triangle through a row-major mat4.
    fn bake_triangle(canonical: &[[f64; 3]; 3], m: &[f64; 16]) -> Vec<f32> {
        let r = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];
        let t = [m[3], m[7], m[11]];
        let mut out = Vec::with_capacity(9);
        for p in canonical {
            for (row, t_i) in r.iter().zip(t.iter()) {
                out.push((row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + t_i) as f32);
            }
        }
        out
    }

    const CANON_TRIANGLE: [[f64; 3]; 3] =
        [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];

    /// RED/GREEN for issue #3575: three occurrences of one `IfcMappedItem`
    /// shape at DIFFERENT rotations (0°, 90°, 180° about Z) — exactly the
    /// "furniture, pipe runs, repeated structural members" case the issue
    /// reports. Before the fix these hash to three distinct mesh rows
    /// (`mesh_reuse_ratio` ≈ 1.0, the bug); after it they collapse to ONE
    /// template mesh with a per-instance rotation.
    ///
    /// Also the correctness gate: reconstructing `world = origin + R *
    /// template_position` from the decoded instance/mesh/vertex tables must
    /// reproduce each occurrence's ORIGINAL world position — wrong rotation
    /// data would place the geometry, just in the wrong spot.
    #[test]
    fn rotated_mapped_item_repeats_dedup_and_reconstruct_correctly() {
        use arrow::array::{Float32Array, Int32Array};
        use ifc_lite_geometry::InstanceMeta;
        use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

        let placements = [
            rot_z_mat4(0.0, [0.0, 0.0, 0.0]),
            rot_z_mat4(90.0, [5.0, 0.0, 0.0]),
            rot_z_mat4(180.0, [0.0, 5.0, 0.0]),
        ];
        let meshes: Vec<MeshData> = placements
            .iter()
            .enumerate()
            .map(|(i, m)| {
                MeshData::new(
                    100 + i as u32,
                    "IfcFurniture".to_string(),
                    bake_triangle(&CANON_TRIANGLE, m),
                    vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
                    vec![0, 1, 2],
                    [0.6, 0.4, 0.2, 1.0],
                )
                .with_instance(Some(InstanceMeta {
                    transform: *m,
                    local_transform: None,
                    canonical_transform: None,
                    rep_identity: 777,
                    instanceable: true,
                }))
            })
            .collect();
        // Expected Y-up world position of each occurrence's vertices: the
        // baked positions we just fed in ARE the Z-up world (origin is
        // [0,0,0] here), so convert with the same swap the server applies.
        let expected_yup: Vec<Vec<[f32; 3]>> = meshes
            .iter()
            .map(|m| {
                (0..3)
                    .map(|v| {
                        let (x, y, z) =
                            zup_to_yup(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]);
                        [x, y, z]
                    })
                    .collect()
            })
            .collect();

        let (data, stats) = serialize_to_parquet_optimized_with_stats(&meshes, false).unwrap();
        assert_eq!(stats.input_meshes, 3);
        assert_eq!(
            stats.unique_meshes, 1,
            "three rotated occurrences of one shape must dedup to ONE template mesh"
        );
        assert!(
            (stats.mesh_reuse_ratio - 3.0).abs() < 1e-6,
            "mesh_reuse_ratio must reflect the real 3x reuse, got {}",
            stats.mesh_reuse_ratio
        );

        // Unframe: [version:u8][flags:u8][instance_len][mesh_len][material_len][vertex_len][index_len][...]
        assert_eq!(data[0], 3, "format version must be bumped for the rotation column (#3575)");
        let instance_len = u32::from_le_bytes(data[2..6].try_into().unwrap()) as usize;
        let mesh_len = u32::from_le_bytes(data[6..10].try_into().unwrap()) as usize;
        let material_len = u32::from_le_bytes(data[10..14].try_into().unwrap()) as usize;
        let vertex_len = u32::from_le_bytes(data[14..18].try_into().unwrap()) as usize;
        let header = 2 + 5 * 4;
        let instance_bytes = Bytes::copy_from_slice(&data[header..header + instance_len]);
        let mesh_start = header + instance_len;
        let mesh_bytes = Bytes::copy_from_slice(&data[mesh_start..mesh_start + mesh_len]);
        let vertex_start = mesh_start + mesh_len + material_len;

        let instance_batch = ParquetRecordBatchReaderBuilder::try_new(instance_bytes)
            .unwrap()
            .build()
            .unwrap()
            .map(|b| b.unwrap())
            .next()
            .unwrap();
        let mesh_batch = ParquetRecordBatchReaderBuilder::try_new(mesh_bytes)
            .unwrap()
            .build()
            .unwrap()
            .map(|b| b.unwrap())
            .next()
            .unwrap();

        let icol = |name: &str| instance_batch.schema().index_of(name).expect(name);
        let f32col = |name: &str| {
            instance_batch
                .column(icol(name))
                .as_any()
                .downcast_ref::<Float32Array>()
                .unwrap()
                .clone()
        };
        let f64col = |name: &str| {
            instance_batch
                .column(icol(name))
                .as_any()
                .downcast_ref::<Float64Array>()
                .unwrap()
                .clone()
        };
        let mesh_idx_col = instance_batch
            .column(icol("mesh_index"))
            .as_any()
            .downcast_ref::<UInt32Array>()
            .unwrap()
            .clone();
        let (ox, oy, oz) = (f64col("origin_x"), f64col("origin_y"), f64col("origin_z"));
        let rot: Vec<Float32Array> = (0..9).map(|i| f32col(&format!("rot{i}"))).collect();

        // Mesh table: one row (the deduplicated template), offset 0.
        assert_eq!(mesh_batch.num_rows(), 1);
        let mcol = |name: &str| mesh_batch.schema().index_of(name).expect(name);
        let vertex_offset = mesh_batch
            .column(mcol("vertex_offset"))
            .as_any()
            .downcast_ref::<UInt32Array>()
            .unwrap()
            .value(0);

        // Vertex table (this test never sets include_normals, so x/y/z only).
        let vertex_bytes = Bytes::copy_from_slice(&data[vertex_start..vertex_start + vertex_len]);
        let vertex_batch = ParquetRecordBatchReaderBuilder::try_new(vertex_bytes)
            .unwrap()
            .build()
            .unwrap()
            .map(|b| b.unwrap())
            .next()
            .unwrap();
        let vcol = |name: &str| vertex_batch.schema().index_of(name).expect(name);
        let vint = |name: &str| {
            vertex_batch
                .column(vcol(name))
                .as_any()
                .downcast_ref::<Int32Array>()
                .unwrap()
                .clone()
        };
        let (vx, vy, vz) = (vint("x"), vint("y"), vint("z"));
        let dequant = 1.0 / VERTEX_MULTIPLIER;

        assert_eq!(instance_batch.num_rows(), 3);
        for (i, expected_for_instance) in expected_yup.iter().enumerate() {
            let mesh_index = mesh_idx_col.value(i);
            assert_eq!(
                mesh_index, 0,
                "all three occurrences must point at the single template mesh"
            );
            let origin = [ox.value(i), oy.value(i), oz.value(i)];
            let r = [
                rot[0].value(i) as f64, rot[1].value(i) as f64, rot[2].value(i) as f64,
                rot[3].value(i) as f64, rot[4].value(i) as f64, rot[5].value(i) as f64,
                rot[6].value(i) as f64, rot[7].value(i) as f64, rot[8].value(i) as f64,
            ];
            for (v, expected) in expected_for_instance.iter().enumerate() {
                let src = vertex_offset as usize + v;
                let template = [
                    vx.value(src) as f64 * dequant as f64,
                    vy.value(src) as f64 * dequant as f64,
                    vz.value(src) as f64 * dequant as f64,
                ];
                let reconstructed = [
                    origin[0] + r[0] * template[0] + r[1] * template[1] + r[2] * template[2],
                    origin[1] + r[3] * template[0] + r[4] * template[1] + r[5] * template[2],
                    origin[2] + r[6] * template[0] + r[7] * template[1] + r[8] * template[2],
                ];
                for axis in 0..3 {
                    assert!(
                        (reconstructed[axis] - expected[axis] as f64).abs() < 1e-3,
                        "instance {i} vertex {v} axis {axis}: reconstructed {:?} vs expected {:?}",
                        reconstructed,
                        expected
                    );
                }
            }
        }
    }

    /// Control for the test above: a RIGID-tier group (one occurrence carries
    /// `canonical_transform`, meaning the template is congruent but not
    /// bit-identical to this occurrence's own geometry) must NOT be
    /// instanced — the per-vertex residual check has nothing bit-identical to
    /// verify against, so #3575's dedup conservatively falls back to today's
    /// content-hash behaviour (each occurrence keeps its own mesh row).
    #[test]
    fn rigid_tier_groups_are_not_rotation_instanced() {
        use ifc_lite_geometry::InstanceMeta;

        let m0 = rot_z_mat4(0.0, [0.0, 0.0, 0.0]);
        let m1 = rot_z_mat4(90.0, [5.0, 0.0, 0.0]);
        let meshes: Vec<MeshData> = [m0, m1]
            .iter()
            .enumerate()
            .map(|(i, m)| {
                MeshData::new(
                    200 + i as u32,
                    "IfcFurniture".to_string(),
                    bake_triangle(&CANON_TRIANGLE, m),
                    vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
                    vec![0, 1, 2],
                    [0.6, 0.4, 0.2, 1.0],
                )
                .with_instance(Some(InstanceMeta {
                    transform: *m,
                    local_transform: None,
                    // Rigid tier: a recovered congruence transform is present.
                    canonical_transform: Some([
                        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0,
                        0.0, 1.0,
                    ]),
                    rep_identity: 888,
                    instanceable: true,
                }))
            })
            .collect();

        let (_, stats) = serialize_to_parquet_optimized_with_stats(&meshes, false).unwrap();
        assert_eq!(
            stats.unique_meshes, 2,
            "rigid-tier (congruent, non-bit-identical) groups must fall back to distinct mesh rows"
        );
    }

    /// Half of the version-byte pair with
    /// `rotated_mapped_item_repeats_dedup_and_reconstruct_correctly` (which
    /// asserts version 3 and reads `rot0..rot8`). The version byte must
    /// describe what the payload CONTAINS, not which code built it: an
    /// unconditional 3 breaks every already-published client
    /// (`@ifc-lite/server-client` throws `Unsupported optimized Parquet
    /// version: 3`) on models that carry no rotation at all.
    ///
    /// This fixture is the sharp case: `InstanceMeta` IS present and the
    /// rotation-aware dedup DOES fire (two occurrences collapse to one
    /// template), but every derived rotation is identity because the reuse is
    /// pure translation. Gating on "the feature ran" or "the model has
    /// instance metadata" would emit 3 here; gating on the emitted rotation
    /// data emits 2, which is exactly what this payload is.
    #[test]
    fn translation_only_reuse_ships_wire_version_2() {
        use ifc_lite_geometry::InstanceMeta;
        use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

        let placements = [
            rot_z_mat4(0.0, [0.0, 0.0, 0.0]),
            rot_z_mat4(0.0, [7.0, 0.0, 0.0]),
        ];
        let meshes: Vec<MeshData> = placements
            .iter()
            .enumerate()
            .map(|(i, m)| {
                MeshData::new(
                    300 + i as u32,
                    "IfcFurniture".to_string(),
                    bake_triangle(&CANON_TRIANGLE, m),
                    vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
                    vec![0, 1, 2],
                    [0.6, 0.4, 0.2, 1.0],
                )
                .with_instance(Some(InstanceMeta {
                    transform: *m,
                    local_transform: None,
                    canonical_transform: None,
                    rep_identity: 999,
                    instanceable: true,
                }))
            })
            .collect();

        let (data, stats) = serialize_to_parquet_optimized_with_stats(&meshes, false).unwrap();
        assert_eq!(
            stats.unique_meshes, 1,
            "translation-only reuse must still deduplicate to one template"
        );
        assert_eq!(
            data[0], 2,
            "no non-identity rotation was emitted, so this is a v2 payload and must say so"
        );

        // A v2 payload must also be v2-SHAPED: the rotation columns a v2
        // client never saw must not be in the table.
        let instance_len = u32::from_le_bytes(data[2..6].try_into().unwrap()) as usize;
        let header = 2 + 5 * 4;
        let instance_bytes = Bytes::copy_from_slice(&data[header..header + instance_len]);
        let batch = ParquetRecordBatchReaderBuilder::try_new(instance_bytes)
            .unwrap()
            .build()
            .unwrap()
            .map(|b| b.unwrap())
            .next()
            .unwrap();
        for i in 0..9 {
            assert!(
                batch.schema().index_of(&format!("rot{i}")).is_err(),
                "rot{i} must be absent from a v2 payload"
            );
        }
        // The placement columns a v2 client DOES read are still there, with
        // the per-occurrence translation the dedup relies on. Origin [7,0,0]
        // in IFC Z-up is [x, z, -y] = [7, 0, 0] in the Y-up wire frame.
        let ox = batch
            .column(batch.schema().index_of("origin_x").unwrap())
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap()
            .clone();
        assert_eq!(batch.num_rows(), 2);
        assert!((ox.value(1) - 7.0).abs() < 1e-9, "got {}", ox.value(1));
    }

    /// Exercises the residual-rejection fallback that
    /// `rotated_mapped_item_repeats_dedup_and_reconstruct_correctly` never
    /// reaches (it always verifies) and `rigid_tier_groups_are_not_rotation_instanced`
    /// short-circuits before (it returns at the `canonical_transform` guard,
    /// never calling `verify_and_derive_placement`). Two occurrences share
    /// `rep_identity`, so `collate_refs` groups them, but occurrence 1's own
    /// baked vertices do NOT match `transform` applied to the template — a
    /// stand-in for a stale/corrupt `InstanceMeta::transform` — so its
    /// residual is `1.0` metre, far past `RECOMPOSITION_TOLERANCE_M`
    /// (1e-4 m). `verify_and_derive_placement`'s `!(max_err <= TOL)` gate
    /// (not `max_err > TOL`) is what must reject this: the same form of
    /// comparison that also rejects a NaN residual, since `NaN <= TOL` is
    /// `false` either way.
    ///
    /// The group-scoped fallback (this module's doc comment above
    /// `collate_rotation_aware_placements`) means the WHOLE group falls back
    /// to content-hash dedup, not just the failing occurrence — occurrence 0
    /// would reconstruct fine on its own but is discarded too, because a
    /// client has no way to trust a rotation-aware template it can only
    /// verify for some of its occurrences.
    #[test]
    fn a_group_with_one_unverifiable_occurrence_falls_back_for_the_whole_group() {
        use ifc_lite_geometry::InstanceMeta;

        let m0 = rot_z_mat4(0.0, [0.0, 0.0, 0.0]);
        let m1 = rot_z_mat4(90.0, [5.0, 0.0, 0.0]);
        // Occurrence 1's baked triangle is the CANONICAL one translated by
        // 1m on X in addition to m1's own placement — `transform` (m1) says
        // where it should be; its own baked vertices disagree by 1m, well
        // past the 1e-4m tolerance.
        let mismatched_triangle: Vec<f32> = bake_triangle(&CANON_TRIANGLE, &m1)
            .iter()
            .enumerate()
            .map(|(i, v)| if i % 3 == 0 { v + 1.0 } else { *v })
            .collect();

        let meshes: Vec<MeshData> = vec![
            MeshData::new(
                400,
                "IfcFurniture".to_string(),
                bake_triangle(&CANON_TRIANGLE, &m0),
                vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
                vec![0, 1, 2],
                [0.6, 0.4, 0.2, 1.0],
            )
            .with_instance(Some(InstanceMeta {
                transform: m0,
                local_transform: None,
                canonical_transform: None,
                rep_identity: 555,
                instanceable: true,
            })),
            MeshData::new(
                401,
                "IfcFurniture".to_string(),
                mismatched_triangle,
                vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
                vec![0, 1, 2],
                [0.6, 0.4, 0.2, 1.0],
            )
            .with_instance(Some(InstanceMeta {
                transform: m1,
                local_transform: None,
                canonical_transform: None,
                rep_identity: 555,
                instanceable: true,
            })),
        ];

        let (_, stats) = serialize_to_parquet_optimized_with_stats(&meshes, false).unwrap();
        assert_eq!(
            stats.unique_meshes, 2,
            "an unverifiable occurrence must reject rotation-aware dedup for its \
             ENTIRE group (both occurrences), not just itself — a partially \
             trusted template is not a safe thing to ship"
        );
    }

    /// Control for the test above, at the OTHER guard: `collate_refs` itself
    /// (`rust/geometry/src/instancing/collate.rs`) checks each occurrence's
    /// vertex/index count against the template BEFORE this module ever runs
    /// `verify_and_derive_placement` — so a real vertex-count mismatch never
    /// reaches this module's `target.positions.len() / 3 != n` guard at all;
    /// `collate_refs` routes the whole group to `flat_indices` first. (That
    /// guard here is defensive dead code on the current caller contract, not
    /// something this fixture can exercise — the count check one layer up is
    /// what actually protects a real shape mismatch.) Either way, the
    /// invariant under test holds: a real vertex-count mismatch must not
    /// produce a trusted rotation-aware template.
    #[test]
    fn a_group_with_a_vertex_count_mismatch_also_falls_back() {
        use ifc_lite_geometry::InstanceMeta;

        let m0 = rot_z_mat4(0.0, [0.0, 0.0, 0.0]);
        let m1 = rot_z_mat4(90.0, [5.0, 0.0, 0.0]);
        // Occurrence 1 carries a FOURTH vertex the template never had —
        // caught by `collate_refs`'s own same-shape guard.
        let mut extra_vertex_triangle = bake_triangle(&CANON_TRIANGLE, &m1);
        extra_vertex_triangle.extend_from_slice(&[0.0, 0.0, 0.0]);

        let meshes: Vec<MeshData> = vec![
            MeshData::new(
                410,
                "IfcFurniture".to_string(),
                bake_triangle(&CANON_TRIANGLE, &m0),
                vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
                vec![0, 1, 2],
                [0.6, 0.4, 0.2, 1.0],
            )
            .with_instance(Some(InstanceMeta {
                transform: m0,
                local_transform: None,
                canonical_transform: None,
                rep_identity: 556,
                instanceable: true,
            })),
            MeshData::new(
                411,
                "IfcFurniture".to_string(),
                extra_vertex_triangle,
                vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
                vec![0, 1, 2, 0, 1, 3],
                [0.6, 0.4, 0.2, 1.0],
            )
            .with_instance(Some(InstanceMeta {
                transform: m1,
                local_transform: None,
                canonical_transform: None,
                rep_identity: 556,
                instanceable: true,
            })),
        ];

        let (_, stats) = serialize_to_parquet_optimized_with_stats(&meshes, false).unwrap();
        assert_eq!(
            stats.unique_meshes, 2,
            "a vertex-count mismatch must reject the group exactly like an \
             over-tolerance residual does, never producing a trusted template"
        );
    }
