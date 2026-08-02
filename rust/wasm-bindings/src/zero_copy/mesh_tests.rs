// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Native unit tests for `mesh.rs`. The `js_sys` typed-array GETTERS need a JS
//! environment, so these exercise the backing buffers directly — which is where
//! the contract that matters lives: the three geometry-diff arrays are read by
//! index, so any length skew mis-attributes every entry after it.

use super::MeshCollection;

#[test]
fn geometry_diff_arrays_stay_index_parallel() {
    let mut c = MeshCollection::new();
    c.push_geometry_hash(7, 111, Some([0.0, 1.0, 2.0, 3.0, 4.0, 5.0]));
    c.push_geometry_hash(9, 222, Some([-1.0, -2.0, -3.0, 10.0, 20.0, 30.0]));

    assert_eq!(c.geometry_hash_ids, vec![7, 9]);
    assert_eq!(c.geometry_hash_values, vec![111, 222]);
    assert_eq!(c.geometry_aabb_values.len(), 2 * 6);
    assert_eq!(&c.geometry_aabb_values[6..], &[-1.0, -2.0, -3.0, 10.0, 20.0, 30.0]);
}

/// A hash with no box must still occupy its six slots. Shortening the array
/// instead would silently shift every LATER entity's box onto the wrong id —
/// the failure mode is wrong answers, not a crash, so it is pinned here.
#[test]
fn a_missing_box_reserves_its_slots_instead_of_shifting_the_array() {
    let mut c = MeshCollection::new();
    c.push_geometry_hash(1, 10, None);
    c.push_geometry_hash(2, 20, Some([1.0, 2.0, 3.0, 4.0, 5.0, 6.0]));

    assert_eq!(c.geometry_aabb_values.len(), 12, "one 6-slot span per id");
    assert!(
        c.geometry_aabb_values[..6].iter().all(|v| v.is_nan()),
        "the absent box must read as NaN, not as a box at the origin"
    );
    assert_eq!(&c.geometry_aabb_values[6..], &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
}

/// Every constructor starts empty, so a collection that never hashed exposes no
/// stale spans.
#[test]
fn constructors_start_with_no_geometry_diff_data() {
    for c in [
        MeshCollection::new(),
        MeshCollection::with_capacity(4),
        MeshCollection::from_vec(Vec::new()),
    ] {
        assert!(c.geometry_hash_ids.is_empty());
        assert!(c.geometry_hash_values.is_empty());
        assert!(c.geometry_aabb_values.is_empty());
    }
}

/// `Clone` is how a batch hands its results on; the boxes must ride with the
/// ids rather than being dropped.
#[test]
fn clone_carries_the_boxes() {
    let mut c = MeshCollection::new();
    c.push_geometry_hash(5, 55, Some([0.5; 6]));
    let cloned = c.clone();
    assert_eq!(cloned.geometry_hash_ids, vec![5]);
    assert_eq!(cloned.geometry_aabb_values, vec![0.5; 6]);
}
