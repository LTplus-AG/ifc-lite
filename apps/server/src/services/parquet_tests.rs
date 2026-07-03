// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `parquet.rs`, split into this ratchet-exempt sibling file
//! to keep the production module under the module-size budget. As a child
//! `#[cfg(test)] mod parquet_tests` it retains `use super::*` access to the
//! parent module's private items, so the tests moved here verbatim.

    use super::*;

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
