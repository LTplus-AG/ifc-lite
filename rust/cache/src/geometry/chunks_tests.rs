// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::geometry::record::tests::sample;

/// The express ids of an uncompressed chunk's records, walking the v28
/// record layout (`record.rs`).
fn ids(chunk: &StoredChunk) -> Vec<u32> {
    let bytes = &chunk.bytes;
    let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
    let mut ids = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        ids.push(word(at) as u32);
        let (vertices, indices) = (word(at + 4), word(at + 8));
        at += 12 + 16;
        at += 4 + word(at);
        at += 1 + 8 + 24 + vertices * 24 + indices * 4 + 1 + 8;
        let flags = bytes[at];
        at += 1;
        for (bit, len) in [(1, 16), (2, 24), (4, 128)] {
            if flags & bit != 0 {
                at += len;
            }
        }
    }
    assert_eq!(ids.len() as u32, chunk.mesh_count);
    ids
}

/// The chunks in output order: closed by the cap as they close, then open.
fn group(meshes: &[CacheMesh]) -> Vec<Vec<u32>> {
    let mut grouper = Grouper::new(false);
    let mut chunks: Vec<StoredChunk> = meshes.iter().filter_map(|mesh| grouper.push(mesh)).collect();
    chunks.extend(grouper.finish());
    chunks.iter().map(ids).collect()
}

/// Each mesh about 3 MiB, so the third in one cell overflows the 8 MiB cap.
fn big(id: u32, origin: [f64; 3]) -> CacheMesh {
    let mut mesh = sample(id, origin);
    mesh.positions = vec![0.0; 3 * 130_000];
    mesh.normals = vec![0.0; 3 * 130_000];
    mesh
}

#[test]
fn meshes_group_by_cell_in_first_insertion_order() {
    let meshes = [
        sample(1, [0.0, 0.0, 0.0]),
        sample(2, [100.0, 0.0, 0.0]),
        sample(3, [1.0, 0.0, 0.0]),
        sample(4, [f64::NAN, 0.0, 0.0]),
        sample(5, [f64::NAN, 1e9, 0.0]),
    ];
    assert_eq!(group(&meshes), vec![vec![1, 3], vec![2], vec![4, 5]]);
}

#[test]
fn negative_zero_shares_the_positive_zero_cell() {
    // `${-0}` is "0" in the TS key, so -0 and 0 are one cell.
    let mut negative = sample(1, [-0.0, 0.0, 0.0]);
    negative.positions[0] = -0.0;
    assert_eq!(group(&[negative, sample(2, [0.0; 3])]), vec![vec![1, 2]]);
}

#[test]
fn a_full_cell_closes_and_reopens_in_its_original_position() {
    let meshes = [big(1, [0.0; 3]), sample(2, [500.0, 0.0, 0.0]), big(3, [0.0; 3]), big(4, [0.0; 3])];
    // The overflow closes [1, 3]; the reopened cell keeps slot 0, ahead of 2.
    assert_eq!(group(&meshes), vec![vec![1, 3], vec![4], vec![2]]);
}

#[test]
fn a_closed_chunk_is_handed_back_the_moment_the_cap_closes_it() {
    // What lets the streaming writer spool it: nothing later can change it.
    let mut grouper = Grouper::new(false);
    assert!(grouper.push(&big(1, [0.0; 3])).is_none());
    assert!(grouper.push(&big(2, [0.0; 3])).is_none());
    let closed = grouper.push(&big(3, [0.0; 3])).expect("the third overflows the cap");
    assert_eq!(ids(&closed), vec![1, 2]);
    assert_eq!(grouper.cells(), 1);
    let held = 2 * big(1, [0.0; 3]).record_len();
    assert_eq!(grouper.peak_open_bytes(), held, "the closing mesh lands after the close");
}

#[test]
fn aabb_is_world_bounds_and_empty_is_zero() {
    let mut grouper = Grouper::new(false);
    grouper.push(&sample(1, [10.0, 20.0, 30.0]));
    let mut empty = sample(2, [500.0; 3]);
    empty.positions.clear();
    grouper.push(&empty);
    let chunks: Vec<StoredChunk> = grouper.finish().collect();
    assert_eq!(chunks[0].aabb, [10.0, 20.0, 30.0, 11.0, 21.0, 30.0]);
    assert_eq!(chunks[1].aabb, [0.0; 6]);
}

#[test]
fn small_chunks_stay_raw_and_large_ones_deflate_when_smaller() {
    let stored = |mesh: CacheMesh, compress: bool| {
        let mut grouper = Grouper::new(compress);
        assert!(grouper.push(&mesh).is_none());
        grouper.finish().next().unwrap()
    };
    let small = stored(sample(1, [0.0; 3]), true);
    assert_eq!(small.flags, 0);
    assert_eq!(small.bytes.len() as u32, small.uncompressed_length);

    let mut big = sample(2, [0.0; 3]);
    big.positions = vec![0.0; 3 * 10_000];
    big.normals = vec![0.0; 3 * 10_000];
    let deflated = stored(big.clone(), true);
    assert_eq!(deflated.flags, CHUNK_FLAG_DEFLATE_RAW);
    let inflated = miniz_oxide::inflate::decompress_to_vec(&deflated.bytes).unwrap();
    assert_eq!(inflated.len() as u32, deflated.uncompressed_length);
    assert_eq!(inflated, stored(big, false).bytes);
}
