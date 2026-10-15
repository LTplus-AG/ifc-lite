// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;

#[test]
fn issue_7292_tilted_front_cannot_make_an_interior_patch_a_near_shared_face() {
    // S_Office entity 979333, first cut, arranged A22 and cutter face42.
    // This interior A patch was retained together with the real tilted front,
    // producing two boundary crossings and deleting the next cut's Z80 cap.
    let own = [[1915.0, 110.0, 80.0], [1825.0, 110.0, 80.0], [1825.0, 110.0, 1668.3333333333333]];
    let other = [[1825.0, 109.99946594238281, 2715.0], [1825.0, 110.0, 80.0], [1915.0, 110.0, 80.0]];
    let c = [1855.0, 110.0, 609.4444444444445];
    let band = NearBand::from_tris(&[other]);
    assert!(near_on_surface_tri(c, &other, &band).is_some(), "centroid alone admits this real interior patch");
    assert!(near_shared_surface_tri(c, &own, &other, &band).is_none(), "the far vertex exceeds the same existing band");
    let exact = [[0.0, 110.0, 0.0], [3750.0, 110.0, 0.0], [0.0, 110.0, 3250.0]];
    assert!(on_surface_normal(c, [0.0, 1.0, 0.0], &[exact]).is_some(), "exact coincidence retains its established path");
}

#[test]
fn issue_7292_whole_flush_triangle_retains_near_shared_face_admission() {
    let gap = 1.0 / 65_536.0;
    let other = [[0.0, 0.0, 0.0], [4.0, 0.0, 0.0], [0.0, 4.0, 0.0]];
    let own = [[1.0, 1.0, gap], [2.0, 1.0, gap], [1.0, 2.0, gap]];
    let c = [4.0 / 3.0, 4.0 / 3.0, gap];
    assert!(near_shared_surface_tri(c, &own, &other, &NearBand::from_tris(&[other])).is_some());
}

#[test]
fn issue_7292_boundary_centroid_uses_exact_arranged_points_on_a_tilted_plane() {
    // Exact triangle is on Z=X+Y. Its rounded centroid has a nonzero exact
    // plane residual of 3/2^54, so a rounded-centroid incidence rejects it.
    let _caps = budget::GLOBAL_CAP_LOCK.lock().unwrap();
    let _element = budget::enter_element();
    budget::begin();
    let t = [[0.0, 0.0, 0.0], [1.0, 0.0, 1.0], [0.0, 4.0, 4.0]];
    let arr = crate::kernel::arrangement::arrange(&[t], &[]);
    let tri = arr.tris_a[0];
    let rounded = super::super::centroid(&arr, tri);
    assert!(on_surface_tri(rounded, &t).is_none());
    assert!(BoundaryCentroid::new(&arr, tri).expect("within budget").on_surface(&[t]));
    let offset = t.map(|p| [p[0], p[1], p[2] + 1.0 / 65_536.0]);
    assert!(!BoundaryCentroid::new(&arr, tri).expect("within budget").on_surface(&[offset]), "a nearby distinct boundary is not the centroid's boundary");
}

#[test]
fn issue_7292_exact_boundary_work_reports_budget_and_returns_no_partial_faces() {
    let _caps = budget::GLOBAL_CAP_LOCK.lock().unwrap();
    let _element = budget::enter_element();
    budget::begin();
    let host = crate::kernel::arrangement::box_mesh([0.0; 3], [1.0; 3]);
    let arr = crate::kernel::arrangement::arrange(&host, &[]);
    struct RestoreCap(Option<u64>);
    impl Drop for RestoreCap {
        fn drop(&mut self) { budget::set_cap(self.0); budget::begin(); }
    }
    let restore = RestoreCap(budget::cap());
    budget::set_cap(Some(2));
    budget::begin();
    let c = BoundaryCentroid::new(&arr, arr.tris_a[0]).expect("centroid is within the real cap");
    assert!(!c.on_surface(&host), "stop boundary work when the configured cap is reached");
    assert!(budget::tripped(), "the exhausted budget must be reported");
    let count = budget::count();
    assert!(BoundaryCentroid::new(&arr, arr.tris_a[0]).is_none());
    assert_eq!(budget::count(), count, "a pretripped centroid query must do no further work");
    assert!(super::super::boolean_vids(&arr, &host, &[], super::super::BoolOp::Difference).is_empty(),
        "classification must not return a partial surface after a real budget trip");
    assert_eq!(budget::count(), count, "the tripped operation must do no further exact work");
    let (exhausted, conforming) = crate::kernel::arrangement::boolean_with_conformity(
        &host, &host, super::super::BoolOp::Difference);
    assert!(exhausted.is_empty() && !conforming, "budget exhaustion is not a conforming empty result");
    drop(restore);
    let (empty, conforming) = crate::kernel::arrangement::boolean_with_conformity(
        &host, &host, super::super::BoolOp::Difference);
    assert!(empty.is_empty() && conforming && !budget::tripped(),
        "subtracting the identical solid is a genuine conforming empty result");
}
