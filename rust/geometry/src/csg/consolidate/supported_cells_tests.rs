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

#[path = "supported_fold_fixture_tests.rs"]
mod actual_fold;

/// #8047: adjacent needles can bound a real thin feature across two planes.
/// Each outer edge has its own healthy opposite cell; the remaining support
/// boundary is intentionally open, as the certificate is local to the patch.
fn supported_patch_8047() -> Vec<[[f64; 3]; 3]> {
    let (a, b, c, d) = (
        [0., 0., 0.], [4., 0., 0.], [4., 0.0002, 0.], [0., 0., -0.0002],
    );
    vec![
        [a, b, c], [a, c, d],
        [b, a, [2., -2., 2.]],
        [c, b, [4., 0.001, 0.001]],
        [d, c, [2., 2., 2.]],
        [a, d, [-0.001, -0.001, 0.]],
    ]
}

#[test]
fn issue_8047_connected_thin_patch_retains_both_planes() {
    let faces = supported_patch_8047();
    assert!(faces[..2].iter().all(|t| tri_is_needle(&t.map(Point3::from))));
    assert!(faces[2..].iter().all(|t| !tri_is_needle(&t.map(Point3::from))));
    let source = buckets(&faces);
    let supported = find(&source);
    assert_eq!(supported.cells.len(), 2);
    assert_eq!(supported.buckets.len(), 2, "the patch spans distinct planes");
    for t in &faces[..2] {
        assert!(supported.cells.contains(&cell_key(&t.map(Point3::from))));
    }
}

#[test]
fn issue_8047_patch_requires_every_unique_opposed_boundary_support() {
    let faces = supported_patch_8047();
    for index in 2..faces.len() {
        let mut missing = faces.clone();
        missing.remove(index);
        assert!(find(&buckets(&missing)).cells.is_empty(), "missing support {index}");
        let mut reversed = faces.clone();
        reversed[index].swap(0, 1);
        assert!(find(&buckets(&reversed)).cells.is_empty(), "reversed support {index}");
        let mut repeated = faces.clone();
        repeated.push(faces[index]);
        assert!(find(&buckets(&repeated)).cells.is_empty(), "duplicate support {index}");
    }
    let mut reversed_patch = faces.clone();
    reversed_patch[1].swap(0, 1);
    assert!(find(&buckets(&reversed_patch)).cells.is_empty(), "unpaired internal edge");
}

#[test]
fn issue_8047_patch_rejects_overlapping_support_bucket() {
    let mut faces = supported_patch_8047();
    let support = faces[2];
    // A strictly interior triangle shares the support's plane and winding,
    // but no patch edge: only the full-bucket nonoverlap proof detects it.
    faces.push(std::array::from_fn(|i| std::array::from_fn(|axis| {
        support[i][axis] * 0.5
            + support[(i + 1) % 3][axis] * 0.25
            + support[(i + 2) % 3][axis] * 0.25
    })));
    assert!(find(&buckets(&faces)).cells.is_empty());
}

#[test]
fn issue_8047_all_needle_closed_shell_cannot_support_itself() {
    let (a, b, c, d) = (
        [0., 0., 0.], [4., 0., 0.], [4., 0.0001, 0.], [0., 0., 0.0001],
    );
    let faces = [[a, c, b], [a, d, c], [b, d, a], [c, d, b]];
    assert!(faces.iter().all(|t| tri_is_needle(&t.map(Point3::from))));
    assert!(find(&buckets(&faces)).cells.is_empty());
}


#[test]
fn issue_8047_coplanar_fans_and_concave_rims_keep_ordinary_cleanup() {
    let convex_corner = [0., 0., -0.0002];
    for replacement in [[0., 0.0002, 0.], [0., 0., 0.0002]] {
        let mut faces = supported_patch_8047();
        for point in faces.iter_mut().flatten() {
            if *point == convex_corner { *point = replacement; }
        }
        assert!(faces[..2].iter().all(|t| tri_is_needle(&t.map(Point3::from))));
        assert!(faces[2..].iter().all(|t| !tri_is_needle(&t.map(Point3::from))));
        let source = buckets(&faces);
        assert!(source.values().all(|tris| nonoverlapping(tris)),
            "fixture must fail convexity rather than the overlap certificate");
        assert!(find(&source).cells.is_empty(), "non-convex ridge {replacement:?}");
    }
}
