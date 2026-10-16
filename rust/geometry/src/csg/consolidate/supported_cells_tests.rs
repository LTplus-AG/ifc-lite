// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
fn buckets(faces: &[[[f64; 3]; 3]]) -> BTreeMap<Bucket, Vec<PlaneTri>> {
    let mut out = BTreeMap::new();
    for t in faces {
        let v = t.map(Point3::from);
        let normal = (v[1] - v[0]).cross(&(v[2] - v[0])).normalize();
        let key = (
            (normal.x * 1000.).round() as i64,
            (normal.y * 1000.).round() as i64,
            (normal.z * 1000.).round() as i64,
            0,
        );
        out.entry(key).or_insert_with(Vec::new).push(PlaneTri {
            v,
            normal,
            tag: None,
        });
    }
    out
}
#[test]
fn issue_7292_isolated_thin_cell_needs_all_three_healthy_opposite_supports() {
    let (a, b, c, d) = (
        [0., 0., 0.],
        [0.0002, 0., 0.],
        [4., 4., 0.],
        [0., -0.001, 0.001],
    );
    let faces = [[a, b, c], [b, a, d], [c, b, d], [a, c, d]];
    assert!(tri_is_needle(&faces[0].map(Point3::from)));
    assert_eq!(find(&buckets(&faces)).cells.len(), 1);
    assert!(
        find(&buckets(&faces[..3])).cells.is_empty(),
        "an open flap is not supported"
    );
    let mut reversed = faces;
    reversed[1].swap(0, 1);
    assert!(
        find(&buckets(&reversed)).cells.is_empty(),
        "same-direction incidence is not support"
    );
}
#[test]
fn issue_7292_bypassed_bucket_cannot_preserve_overlapping_or_reversed_interior_faces() {
    let (a, b, c) = ([0., 0., 0.], [0.0002, 0., 0.], [4., 4., 0.]);
    let faces = [
        [a, b, c],
        [b, a, [0., -0.0001, 0.]],
        [c, b, [8., 0., 0.]],
        [a, c, [-4., 4., 0.]],
    ];
    assert_eq!(find(&buckets(&faces)).cells.len(), 1);
    let interior = [[1., 0.2, 0.], [1.2, 0.2, 0.], [1.1, 0.3, 0.]];
    let mut overlapping = faces.to_vec();
    overlapping.push(interior);
    assert!(
        find(&buckets(&overlapping)).cells.is_empty(),
        "a marked bucket cannot preserve an unrelated overlapping face"
    );
    // Signed plane buckets are an established policy. Exercise SAT's winding
    // independence directly rather than changing opposite-normal grouping.
    overlapping.last_mut().unwrap().swap(0, 1);
    let signed = buckets(&overlapping);
    let mixed = signed.into_values().flatten().collect::<Vec<_>>();
    assert!(!nonoverlapping(&mixed));
}

#[test]
fn issue_7292_sorted_support_preserves_signed_zero_and_exact_oriented_cell_membership() {
    // Dyadic coordinates survive the actual f64 -> mesh f32 -> f64 path exactly.
    let (a, b, c, d) = (
        [0., 0., 0.], [1. / 8192., 0., 0.],
        [4., 4., 0.], [0., -1. / 1024., 1. / 1024.],
    );
    let mut faces = [[a, b, c], [b, a, d], [c, b, d], [a, c, d]];
    for (i, face) in faces.iter_mut().enumerate() {
        for p in face {
            for coordinate in p {
                if *coordinate == 0.0 && i % 2 == 0 { *coordinate = -0.0; }
            }
        }
    }
    let supported = find(&buckets(&faces));
    assert_eq!(supported.cells.len(), 1, "signed zeros must share source edges");
    let cell = [a, b, c].map(Point3::from);
    let normal = Vector3::new(0., 0., 1.);
    let mut mesh = Mesh::new();
    append(&mut mesh, &cell, &normal);
    append(&mut mesh, &cell, &normal);
    assert!(!has_uncertified_needle(&mesh, &supported),
        "membership permits repeated identical certified cells; closure is checked separately");
    let mut reordered = cell;
    reordered.rotate_left(1);
    let mut mesh = Mesh::new();
    append(&mut mesh, &reordered, &normal);
    assert!(has_uncertified_needle(&mesh, &supported),
        "the existing certificate uses exact source order, without cyclic canonicalization");
    reordered.swap(0, 1);
    let mut mesh = Mesh::new();
    append(&mut mesh, &reordered, &normal);
    assert!(has_uncertified_needle(&mesh, &supported),
        "a reversed source cell is not an exact certified-cell key");
}

#[test]
fn issue_7292_sorted_incidence_rejects_duplicate_and_nonmanifold_source_edges() {
    let (a, b, c, d) = (
        [0., 0., 0.], [1. / 8192., 0., 0.],
        [4., 4., 0.], [0., -1. / 1024., 1. / 1024.],
    );
    let faces = [[a, b, c], [b, a, d], [c, b, d], [a, c, d]];
    assert_eq!(find(&buckets(&faces)).cells.len(), 1);
    for extra in [faces[0], faces[1], [b, a, [0., -2., 1.]]] {
        let mut duplicated = faces.to_vec();
        duplicated.push(extra);
        assert!(find(&buckets(&duplicated)).cells.is_empty(),
            "a third use of a thin-cell edge cannot provide isolated opposite support");
    }
    let mut collapsed = faces;
    collapsed[0][1] = collapsed[0][0];
    assert!(find(&buckets(&collapsed)).cells.is_empty(),
        "a repeated vertex cannot supply three nonzero supporting edges");
}
