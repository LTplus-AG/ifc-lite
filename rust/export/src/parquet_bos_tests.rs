// SPDX-License-Identifier: MPL-2.0
//! Tests for `parquet_bos.rs`, split out under the house pattern (AGENTS.md)
//! so the production module stays under the module-size ratchet; this file
//! is exempt via the `_tests.rs` suffix.

use super::*;
use std::io::Read;

use arrow::array::AsArray;
use arrow::datatypes::{ArrowPrimitiveType, Float32Type, UInt32Type};
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

#[test]
fn duplex_exports_valid_bos() {
    let bos = export_bos(&fixture_or_skip!("ara3d/duplex.ifc"), &ParquetBosOptions::default())
        .expect("bos export");
    assert!(bos.len() > 1000, "non-trivial archive");

    // Re-open the zip and verify the expected tables + parquet magic.
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bos)).expect("valid zip");
    let names: Vec<String> = (0..archive.len())
        .map(|i| archive.by_index(i).unwrap().name().to_string())
        .collect();
    for expected in [
        "Entities.parquet",
        "Properties.parquet",
        "Quantities.parquet",
        "VertexBuffer.parquet",
        "IndexBuffer.parquet",
        "Meshes.parquet",
        "Metadata.json",
    ] {
        assert!(names.iter().any(|n| n == expected), "missing {expected}");
    }

    // TS/Rust BOS parity check: running the same `ara3d/duplex.ifc` fixture
    // through `packages/export/src/parquet-exporter.ts` also produces
    // `Relationships.parquet`, `Strings.parquet`, and `SpatialHierarchy.parquet`.
    // This crate does not yet write those three tables — pin that explicitly
    // so a future silent narrowing (or widening) of the gap fails a test
    // instead of going unnoticed.
    for not_yet_ported in ["Relationships.parquet", "Strings.parquet", "SpatialHierarchy.parquet"] {
        assert!(
            !names.iter().any(|n| n == not_yet_ported),
            "{not_yet_ported} is now written here — the TS/Rust BOS parity gap noted \
             in this file's module doc comment has narrowed; update the doc comment"
        );
    }

    // Each parquet entry starts + ends with the PAR1 magic.
    let mut entities = Vec::new();
    archive.by_name("Entities.parquet").unwrap().read_to_end(&mut entities).unwrap();
    assert_eq!(&entities[0..4], b"PAR1", "parquet header magic");
    assert_eq!(&entities[entities.len() - 4..], b"PAR1", "parquet footer magic");

    // Metadata.json is valid + reports entities.
    let mut meta = String::new();
    archive.by_name("Metadata.json").unwrap().read_to_string(&mut meta).unwrap();
    let v: serde_json::Value = serde_json::from_str(&meta).unwrap();
    assert_eq!(v["format"], "ara3d-bos");
    assert!(v["entityCount"].as_u64().unwrap() > 50);
    assert!(v["vertexCount"].as_u64().unwrap() > 0);
}

/// A minimal, otherwise-valid mesh with zero normals.
fn mesh(express_id: u32, positions: Vec<f32>, indices: Vec<u32>) -> MeshData {
    let normals = vec![0.0; positions.len()];
    MeshData::new(express_id, "IfcWall".into(), positions, normals, indices, [0.5, 0.5, 0.5, 1.0])
}

/// Read one parquet table back into its record batches. Through a file,
/// because `std::fs::File` is the `ChunkReader` this crate's dependency set
/// has (no `bytes` crate here, and the revert oracle cannot restore a
/// dependency change, #4592).
fn read_table(bytes: Vec<u8>) -> Vec<RecordBatch> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    let path = std::env::temp_dir().join(format!(
        "ifc-lite-bos-{}-{}.parquet",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&path, bytes).expect("write temp parquet");
    let file = std::fs::File::open(&path).expect("open temp parquet");
    let batches = ParquetRecordBatchReaderBuilder::try_new(file)
        .expect("parquet reader")
        .build()
        .expect("record batch reader")
        .collect::<Result<Vec<_>, _>>()
        .expect("batches");
    let _ = std::fs::remove_file(&path);
    batches
}

/// Every value of one primitive column, across batches.
fn column<T: ArrowPrimitiveType>(batches: &[RecordBatch], name: &str) -> Vec<T::Native> {
    batches
        .iter()
        .flat_map(|b| {
            let col = b.column_by_name(name).unwrap_or_else(|| panic!("column {name}"));
            col.as_primitive::<T>().values().to_vec()
        })
        .collect()
}

/// The join the twin's `parquet-geometry.test.ts` reads, run against the
/// Rust writer: `Meshes.VertexStart` lands on the mesh's first vertex,
/// `IndexBuffer` rows carry MESH-LOCAL indices (upstream BOS: "Local mesh
/// face-corner indices"), and `IndexStart`/`IndexCount` are in scalar index
/// units so the triangle row is `IndexStart / 3`.
///
/// Two meshes of different sizes, so a global index is distinguishable from a
/// local one (mesh b's first corner is 0 locally, 3 globally) and a scalar
/// start from a triangle start (6 vs 2).
#[test]
fn meshes_table_joins_the_index_and_vertex_tables() {
    let a = mesh(11, vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0], vec![0, 1, 2]);
    let b = mesh(
        22,
        vec![5.0, 5.0, 5.0, 6.0, 5.0, 5.0, 6.0, 6.0, 5.0, 5.0, 6.0, 5.0],
        vec![0, 1, 2, 0, 2, 3],
    );
    let (vb, ib, mb, vcount, tcount) = geometry_tables_from_meshes(&[a, b]).expect("tables");
    assert_eq!((vcount, tcount), (7, 3));

    let meshes = read_table(mb);
    assert_eq!(column::<UInt32Type>(&meshes, "ExpressId"), vec![11, 22]);
    assert_eq!(column::<UInt32Type>(&meshes, "VertexStart"), vec![0, 3]);
    assert_eq!(column::<UInt32Type>(&meshes, "VertexCount"), vec![3, 4]);
    assert_eq!(column::<UInt32Type>(&meshes, "IndexStart"), vec![0, 3], "scalar index units");
    assert_eq!(column::<UInt32Type>(&meshes, "IndexCount"), vec![3, 6], "scalar index units");

    let vertices = read_table(vb);
    let xs = column::<Float32Type>(&vertices, "X");
    assert_eq!(xs.len(), 7);
    assert_eq!(xs[3], 5.0, "VertexStart lands on mesh b's first vertex");

    // Mesh b's triangle rows start at IndexStart / 3 and hold LOCAL indices.
    let indices = read_table(ib);
    let i0 = column::<UInt32Type>(&indices, "Index0");
    let i1 = column::<UInt32Type>(&indices, "Index1");
    let i2 = column::<UInt32Type>(&indices, "Index2");
    assert_eq!(i0.len(), 3);
    let rows: Vec<[u32; 3]> = (0..3).map(|r| [i0[r], i1[r], i2[r]]).collect();
    assert_eq!(rows[0], [0, 1, 2]);
    assert_eq!(rows[1], [0, 1, 2], "mesh b's first corner is local 0, not global 3");
    assert_eq!(rows[2], [0, 2, 3]);
    // And resolving them the way a reader must (local + VertexStart) reaches
    // mesh b's own vertices, which a global index would double-offset.
    let vstart = column::<UInt32Type>(&meshes, "VertexStart")[1] as usize;
    for row in &rows[1..] {
        for &corner in row {
            let v = vstart + corner as usize;
            assert!(xs[v] >= 5.0, "corner {corner} of mesh b resolves to vertex {v} (x={})", xs[v]);
        }
    }
}

/// A mesh whose normals do not cover its positions is skipped whole, the way
/// the glTF and OBJ writers skip it, instead of shifting every later mesh's
/// normals or failing the archive. The mesh AFTER it must keep its own
/// normals at its own vertices.
#[test]
fn a_mesh_with_short_normals_is_skipped_without_misaligning_the_rest() {
    let good = mesh(1, vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0], vec![0, 1, 2]);
    let mut short = mesh(2, vec![5.0, 5.0, 5.0, 6.0, 5.0, 5.0, 6.0, 6.0, 5.0], vec![0, 1, 2]);
    short.normals.truncate(6);
    let mut marked = mesh(3, vec![9.0, 9.0, 9.0, 8.0, 9.0, 9.0, 8.0, 8.0, 9.0], vec![0, 1, 2]);
    marked.normals = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];

    let (vb, _ib, mb, vcount, tcount) =
        geometry_tables_from_meshes(&[good, short, marked]).expect("a short mesh must not fail the archive");
    assert_eq!((vcount, tcount), (6, 2));
    let meshes = read_table(mb);
    assert_eq!(column::<UInt32Type>(&meshes, "ExpressId"), vec![1, 3], "the short mesh is not a row");
    assert_eq!(column::<UInt32Type>(&meshes, "VertexStart"), vec![0, 3]);

    let vertices = read_table(vb);
    let xs = column::<Float32Type>(&vertices, "X");
    let nz = column::<Float32Type>(&vertices, "NormalZ");
    assert_eq!(xs.len(), nz.len(), "position and normal columns stay in lockstep");
    // Mesh 3's vertices carry mesh 3's normals, not a normal shifted off the
    // skipped mesh's partial run.
    for v in 3..6 {
        assert!(xs[v] >= 8.0, "vertex {v} belongs to mesh 3");
        assert_eq!(nz[v], 1.0, "vertex {v} carries mesh 3's own normal");
    }
}
