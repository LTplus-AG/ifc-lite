// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::geometry::record::tests::sample;

#[test]
fn meshes_group_by_cell_in_first_insertion_order() {
    let meshes = [
        sample(1, [0.0, 0.0, 0.0]),
        sample(2, [100.0, 0.0, 0.0]),
        sample(3, [1.0, 0.0, 0.0]),
        sample(4, [f64::NAN, 0.0, 0.0]),
        sample(5, [f64::NAN, 1e9, 0.0]),
    ];
    assert_eq!(group(&meshes), vec![vec![0, 2], vec![1], vec![3, 4]]);
}

#[test]
fn negative_zero_shares_the_positive_zero_cell() {
    // `${-0}` is "0" in the TS key, so -0 and 0 are one cell.
    let mut negative = sample(1, [-0.0, 0.0, 0.0]);
    negative.positions[0] = -0.0;
    assert_eq!(group(&[negative, sample(2, [0.0; 3])]), vec![vec![0, 1]]);
}

#[test]
fn a_full_cell_closes_and_reopens_in_its_original_position() {
    // Each mesh is about 3 MiB, so the third in one cell overflows
    // the 8 MiB soft cap and closes the first two.
    let big = |id: u32, origin: [f64; 3]| {
        let mut mesh = sample(id, origin);
        mesh.positions = vec![0.0; 3 * 130_000];
        mesh.normals = vec![0.0; 3 * 130_000];
        mesh
    };
    let meshes = [
        big(1, [0.0; 3]),
        sample(2, [500.0, 0.0, 0.0]),
        big(3, [0.0; 3]),
        big(4, [0.0; 3]),
    ];
    // The overflow closes [0, 2]; the reopened cell keeps slot 0, ahead of 1.
    assert_eq!(group(&meshes), vec![vec![0, 2], vec![3], vec![1]]);
}

#[test]
fn aabb_is_world_bounds_and_empty_is_zero() {
    let meshes = [sample(1, [10.0, 20.0, 30.0])];
    assert_eq!(aabb(&meshes, &[0]), [10.0, 20.0, 30.0, 11.0, 21.0, 30.0]);
    let mut empty = sample(2, [5.0; 3]);
    empty.positions.clear();
    assert_eq!(aabb(&[empty], &[0]), [0.0; 6]);
}

#[test]
fn small_chunks_stay_raw_and_large_ones_deflate_when_smaller() {
    let meshes = [sample(1, [0.0; 3])];
    let small = store(&meshes, &[0], true);
    assert_eq!(small.flags, 0);
    assert_eq!(small.bytes.len() as u32, small.uncompressed_length);

    let mut big = sample(2, [0.0; 3]);
    big.positions = vec![0.0; 3 * 10_000];
    big.normals = vec![0.0; 3 * 10_000];
    let stored = store(&[big.clone()], &[0], true);
    assert_eq!(stored.flags, CHUNK_FLAG_DEFLATE_RAW);
    let inflated = miniz_oxide::inflate::decompress_to_vec(&stored.bytes).unwrap();
    assert_eq!(inflated.len() as u32, stored.uncompressed_length);
    assert_eq!(inflated, store(&[big], &[0], false).bytes);
}
