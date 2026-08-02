// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Corpus-replay gate for the `rust/geometry/fuzz` targets.
//!
//! `cargo fuzz` itself needs nightly + `cargo-fuzz` and only runs on a
//! schedule (`.github/workflows/fuzz.yml`, non-blocking). This test replays
//! the corpus committed under `fuzz/corpus/<target>/` through the SAME entry
//! points the fuzz targets exercise, using plain `cargo test` on stable — so
//! it runs in the required `rust-tests` lane (`cargo test --workspace
//! --exclude ifc-lite-wasm`) and blocks merge. Any crash a scheduled fuzz run
//! finds gets its minimized input committed here so the fix is proven and
//! the regression can never silently come back.
//!
//! The byte-decoding helpers below intentionally mirror
//! `fuzz/fuzz_targets/{triangulate_polygon,kernel_subtract}.rs` byte-for-byte
//! (same chunk size, same cap, same field order) so a corpus file replays
//! identically here and under `cargo fuzz run`. Keep them in sync.

use ifc_lite_geometry::kernel::mesh_bridge::subtract;
use ifc_lite_geometry::{triangulate_polygon, Mesh, Point2};
use std::panic::AssertUnwindSafe;
use std::path::Path;

const MAX_POINTS: usize = 32;
const MAX_TRIS_PER_MESH: usize = 8;

fn points_from_bytes(data: &[u8]) -> Vec<Point2<f64>> {
    data.chunks_exact(16)
        .take(MAX_POINTS)
        .map(|c| {
            let x = f64::from_le_bytes(c[0..8].try_into().expect("8-byte chunk"));
            let y = f64::from_le_bytes(c[8..16].try_into().expect("8-byte chunk"));
            Point2::new(x, y)
        })
        .collect()
}

fn mesh_from_bytes(data: &[u8]) -> Mesh {
    let mut positions = Vec::with_capacity(MAX_TRIS_PER_MESH * 9);
    for chunk in data.chunks_exact(4).take(MAX_TRIS_PER_MESH * 9) {
        positions.push(f32::from_le_bytes(chunk.try_into().expect("4-byte chunk")));
    }
    let tri_count = positions.len() / 9;
    positions.truncate(tri_count * 9);

    let mut mesh = Mesh::new();
    mesh.indices = (0..(tri_count * 3) as u32).collect();
    mesh.positions = positions;
    mesh
}

/// Every file directly under `dir`, sorted for a deterministic run order.
fn corpus_files(dir: &Path) -> Vec<std::path::PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<_> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    files.sort();
    files
}

/// Run `f` over every corpus file in `dir`, catching panics so one bad input
/// doesn't hide failures in the rest of the corpus. Returns the file names
/// that panicked.
fn replay(dir: &Path, mut f: impl FnMut(&[u8])) -> Vec<String> {
    let mut panicked = Vec::new();
    for path in corpus_files(dir) {
        let data = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| f(&data)));
        if result.is_err() {
            panicked.push(name);
        }
    }
    panicked
}

#[test]
fn triangulate_polygon_corpus_never_panics() {
    let dir = Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/fuzz/corpus/triangulate_polygon"
    ));
    let panicked = replay(dir, |data| {
        let points = points_from_bytes(data);
        let _ = triangulate_polygon(&points);
    });
    assert!(
        panicked.is_empty(),
        "triangulate_polygon panicked on committed corpus file(s): {panicked:?}"
    );
    // The corpus dir must actually be found and non-empty, or this test
    // would silently pass on an accidentally-moved/renamed directory.
    assert!(
        !corpus_files(dir).is_empty(),
        "no corpus files found at {dir:?} - the replay gate found nothing to replay"
    );
}

#[test]
fn kernel_subtract_corpus_never_panics() {
    let dir = Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/fuzz/corpus/kernel_subtract"
    ));
    let panicked = replay(dir, |data| {
        let mid = data.len() / 2;
        let host = mesh_from_bytes(&data[..mid]);
        let cutter = mesh_from_bytes(&data[mid..]);
        let _ = subtract(&host, &cutter);
    });
    assert!(
        panicked.is_empty(),
        "kernel subtract panicked on committed corpus file(s): {panicked:?}"
    );
    assert!(
        !corpus_files(dir).is_empty(),
        "no corpus files found at {dir:?} - the replay gate found nothing to replay"
    );
}
