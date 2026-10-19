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
    assert!(near_shared_surface_tri(c, &own, own.map(e).each_ref(), &other, &band).is_none(), "the far vertex exceeds the same existing band");
    let exact = [[0.0, 110.0, 0.0], [3750.0, 110.0, 0.0], [0.0, 110.0, 3250.0]];
    assert!(on_surface_normal(c, [0.0, 1.0, 0.0], &[exact]).is_some(), "exact coincidence retains its established path");
}

#[test]
fn issue_7292_whole_flush_triangle_retains_near_shared_face_admission() {
    let gap = 1.0 / 65_536.0;
    let other = [[0.0, 0.0, 0.0], [4.0, 0.0, 0.0], [0.0, 4.0, 0.0]];
    let own = [[1.0, 1.0, gap], [2.0, 1.0, gap], [1.0, 2.0, gap]];
    let c = [4.0 / 3.0, 4.0 / 3.0, gap];
    assert!(near_shared_surface_tri(c, &own, own.map(e).each_ref(), &other, &NearBand::from_tris(&[other])).is_some());
}

#[test]
fn issue_7292_boundary_centroid_uses_exact_arranged_points_on_a_tilted_plane() {
    // Exact triangle is on Z=X+Y. Its rounded centroid has a nonzero exact
    // plane residual of 3/2^54, so a rounded-centroid incidence rejects it.
    let _caps = budget::GLOBAL_CAP_LOCK.lock().unwrap();
    let _test_caps = budget::test_caps::scope();
    let _element = budget::enter_element();
    budget::begin();
    let t = [[0.0, 0.0, 0.0], [1.0, 0.0, 1.0], [0.0, 4.0, 4.0]];
    let arr = crate::kernel::arrangement::arrange(&[t], &[]);
    let tri = arr.tris_a[0];
    let rounded = super::super::centroid(&arr, tri);
    assert!(on_surface_tri(rounded, &t).is_none());
    assert!(BoundaryCentroid::new(&arr, tri).expect("within budget").on_surface(&[t]), "the exact arranged centroid must remain on the tilted source plane");
    let offset = t.map(|p| [p[0], p[1], p[2] + 1.0 / 65_536.0]);
    assert!(!BoundaryCentroid::new(&arr, tri).expect("within budget").on_surface(&[offset]), "a nearby distinct boundary is not the centroid's boundary");
}

#[test]
fn issue_7292_exact_boundary_work_reports_budget_and_returns_no_partial_faces() {
    let _caps = budget::GLOBAL_CAP_LOCK.lock().unwrap();
    let _test_caps = budget::test_caps::scope();
    let _element = budget::enter_element();
    budget::begin();
    let host = crate::kernel::arrangement::box_mesh([0.0; 3], [1.0; 3]);
    let arr = crate::kernel::arrangement::arrange(&host, &[]);
    struct RestoreCap(Option<u64>);
    impl Drop for RestoreCap {
        fn drop(&mut self) { budget::test_caps::set_cap(self.0); budget::begin(); }
    }
    let restore = RestoreCap(budget::cap());
    budget::test_caps::set_cap(Some(2));
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

fn implicit_at_7292(p: [f64; 3], reverse: bool, triple: bool) -> crate::kernel::ImplicitPoint {
    use crate::kernel::{ImplicitPoint, Lpi, Tpi};
    if triple {
        let [x, y, z] = p;
        ImplicitPoint::Tpi(Tpi { planes: [
            [[x, 0.0, 0.0], [x, 1.0, 0.0], [x, 0.0, 1.0]],
            [[0.0, y, 0.0], [0.0, y, 1.0], [1.0, y, 0.0]],
            [[0.0, 0.0, z], [1.0, 0.0, z], [0.0, 1.0, z]],
        ] })
    } else {
        let [x, y, z] = p;
        let (a, b) = ([x, y, z - 1.0], [x, y, z + 1.0]);
        ImplicitPoint::Lpi(Lpi { p: if reverse { b } else { a }, q: if reverse { a } else { b },
            r: [0.0, 0.0, z], s: [1.0, 0.0, z], t: [0.0, 1.0, z] })
    }
}

#[test]
fn issue_7292_centroid_interval_rejections_equal_exact_for_mixed_symbolic_points() {
    use crate::kernel::{ImplicitPoint, interval, rational};
    let _caps = budget::GLOBAL_CAP_LOCK.lock().unwrap();
    let _test_caps = budget::test_caps::scope();
    let _element = budget::enter_element();
    budget::begin();
    let points = [[0.0, 0.0, 0.0], [1.0, 0.0, 1.0], [0.0, 4.0, 4.0]];
    let exact_plane = points;
    let planes = [exact_plane, exact_plane.map(|p| [p[0], p[1], p[2] + 1.0 / 65536.0]),
        [[0.0, 0.0, 2.0], [4.0, 0.0, 2.0], [0.0, 4.0, 2.0]]];
    for reverse in [false, true] {
        let symbolic = [ImplicitPoint::Explicit(points[0]), implicit_at_7292(points[1], reverse, false), implicit_at_7292(points[2], false, true)];
        let iv = centroid_interval(symbolic.each_ref().map(interval::ilambda_cached)).expect("finite mixed homogeneous centroid");
        let exact = symbolic.each_ref().map(rational::point_of);
        let three = num_rational::BigRational::from_integer(3.into());
        let centroid = std::array::from_fn(|k| (&exact[0][k] + &exact[1][k] + &exact[2][k]) / &three);
        assert!(centroid_plane_sign(&iv, &exact_plane).is_none(), "true coplanarity must escalate, including negative homogeneous denominators");
        let mut definitive = 0;
        for t in planes {
            for other in [t, [t[0], t[2], t[1]]] {
                if let Some(sign) = centroid_plane_sign(&iv, &other) {
                    definitive += 1;
                    assert_eq!(sign, rational::orient3d_exact_pt(&centroid, other[0], other[1], other[2]), "interval rejection must equal the exact arranged centroid oracle");
                }
            }
        }
        assert!(definitive >= 4, "distinct planes should be rejected without rational predicates even when source vertices straddle them");
        for other in [exact_plane, exact_plane.map(|p| [p[0] + 20.0, p[1], p[2]]), exact_plane.map(|p| [p[0], p[1] - 20.0, p[2]])] {
            let outside = (0..3).any(|k| {
                let lower = other.iter().map(|p| p[k]).fold(f64::INFINITY, f64::min);
                let upper = other.iter().map(|p| p[k]).fold(f64::NEG_INFINITY, f64::max);
                centroid[k] < num_rational::BigRational::from_float(lower).unwrap()
                    || centroid[k] > num_rational::BigRational::from_float(upper).unwrap()
            });
            assert_eq!(centroid_outside_bounds(&iv, &other), outside, "definite homogeneous bounds must match the exact mixed-point centroid, including signed denominators");
        }
    }
}

#[test]
fn issue_7292_centroid_interval_rejects_without_rational_work_and_caches_exact_fallback() {
    let _caps = budget::GLOBAL_CAP_LOCK.lock().unwrap();
    let _test_caps = budget::test_caps::scope();
    let _element = budget::enter_element();
    budget::begin();
    let t = [[0.0, 0.0, 0.0], [1.0, 0.0, 1.0], [0.0, 4.0, 4.0]];
    let arr = crate::kernel::arrangement::arrange(&[t], &[]);
    let centroid = BoundaryCentroid::new(&arr, arr.tris_a[0]).expect("within budget");
    let before = budget::count();
    let offset = t.map(|p| [p[0], p[1], p[2] + 1.0]);
    assert!(!centroid.on_surface(&[offset]));
    assert_eq!(budget::count(), before, "a proved non-boundary query does no exact work");
    let remote = t.map(|p| [p[0] + 20.0, p[1] + 20.0, p[2] + 40.0]);
    assert!(!centroid.on_surface(&[remote]), "a remote triangle on the same exact plane is not this boundary");
    assert_eq!(budget::count(), before, "a proved outside-footprint query also does no exact work");
    assert!(centroid.point.get().is_none());
    let first_before = budget::count();
    assert!(centroid.on_surface(&[t]), "the rounded-centroid counterexample remains an exact boundary");
    let first_cost = budget::count() - first_before;
    let second_before = budget::count();
    assert!(centroid.on_surface(&[t]));
    let second_cost = budget::count() - second_before;
    assert_eq!(first_cost, second_cost + 1, "exact centroid construction is charged once while repeated exact predicates remain charged");
}

#[test]
fn issue_7292_centroid_interval_range_failures_use_exact_fallback() {
    use crate::kernel::interval::{ilambda_cached, RnInterval};
    let one = RnInterval::point(1.0);
    let zero = RnInterval::point(0.0);
    for d in [zero, RnInterval { lo: -1.0, hi: 1.0 }, RnInterval::point(1e-200)] {
        assert!(centroid_interval([([one; 3], d); 3]).is_none(), "undefined/underflowed denominators must never decide incidence");
    }
    assert!(centroid_interval([([RnInterval::point(f64::MAX); 3], one); 3]).is_none(), "overflowed centroid sums must escalate");
    let t = [[1e200, 0.0, 0.0], [2e200, 0.0, 0.0], [1e200, 1.0, 0.0]];
    let symbolic = t.map(crate::kernel::ImplicitPoint::Explicit);
    let iv = centroid_interval(symbolic.each_ref().map(ilambda_cached)).expect("finite homogeneous inputs");
    assert!(centroid_plane_sign(&iv, &t).is_none(), "an unsafe determinant range must escalate even when all inputs are finite");
    let _caps = budget::GLOBAL_CAP_LOCK.lock().unwrap();
    let _test_caps = budget::test_caps::scope();
    let _element = budget::enter_element();
    budget::begin();
    let mut arr = crate::kernel::arrangement::arrange(&[], &[]);
    let tri = symbolic.map(|p| arr.interner.intern(p));
    assert!(BoundaryCentroid::new(&arr, tri).unwrap().on_surface(&[t]), "finite overflow-risk inputs still get the exact boundary verdict");
}

#[test]
fn issue_7292_centroid_bounds_keep_boundary_and_uncertain_arithmetic() {
    use crate::kernel::interval::RnInterval;
    let one = RnInterval::point(1.0);
    let bounds = [[0.0; 3], [1.0; 3], [0.0, 1.0, 0.0]];
    for sign in [-1.0, 1.0] {
        let on_boundary = ([RnInterval::point(sign), RnInterval::point(0.0), RnInterval::point(0.0)], RnInterval::point(sign));
        assert!(!centroid_outside_bounds(&on_boundary, &bounds), "exact equality to an AABB face must remain a candidate");
    }
    assert!(!centroid_outside_bounds(&([one; 3], RnInterval { lo: -1.0, hi: 1.0 }), &bounds));
    let huge = RnInterval::point(f64::MAX);
    assert!(!centroid_outside_bounds(&([huge; 3], huge), &[[f64::MAX; 3]; 3]), "overflowed comparisons retain candidates for exact fallback");
}

// #7292: S_Office entity 979333's closed host and two closed cutters,
// captured after the production S16 import snap. Caller units are mm.
// Same closed box and face diagonals as the actual caller, avoiding a
// triangulator change in a regression about arranged surface ownership.
fn cut0_host_7292() -> crate::Mesh {
    let vertices = [
        [3750.0, 110.0, 0.0],
        [0.0, 20.0, 0.0],
        [0.0, 110.0, 0.0],
        [3750.0, 20.0, 0.0],
        [3750.0, 110.0, 3250.0],
        [0.0, 110.0, 3250.0],
        [0.0, 20.0, 3250.0],
        [3750.0, 20.0, 3250.0],
    ];
    let faces = [
        [0, 1, 2],
        [1, 0, 3],
        [4, 5, 6],
        [6, 7, 4],
        [1, 3, 7],
        [1, 7, 6],
        [3, 0, 4],
        [3, 4, 7],
        [0, 2, 5],
        [0, 5, 4],
        [2, 1, 6],
        [2, 6, 5],
    ];
    let tris: Vec<Tri> = faces.iter().map(|t| t.map(|i| vertices[i])).collect();
    crate::kernel::mesh_bridge::tris_to_mesh(&tris)
}

// First cutter: 24 vertices / 44 triangles, including its tilted Y front.
fn cut0_cutter_7292() -> crate::Mesh {
    let vertices = [
        [0.0, 125.0, 0.0],
        [0.0, 125.0, 80.0],
        [1825.0, 125.0, 80.0],
        [1825.0, 125.0, 2715.0],
        [0.0, 125.0, 2715.0],
        [0.0, 125.0, 3250.0],
        [3750.0, 125.0, 3250.0],
        [3749.999755859375, 125.0, 2715.0],
        [1915.0, 125.0, 80.0],
        [3749.999755859375, 125.0, 80.0],
        [3750.0, 125.0, 0.0],
        [1915.0, 125.0, 2715.0],
        [1825.0, 110.0, 80.0],
        [1825.0, 109.99946594238281, 2715.0],
        [0.0, 110.0, 2715.0],
        [0.0, 110.0, 3250.0],
        [3750.0, 110.0, 3250.0],
        [3749.999755859375, 109.99888610839844, 2715.0],
        [1915.0, 109.99943542480469, 2715.0],
        [1915.0, 110.0, 80.0],
        [3749.999755859375, 110.0, 80.0],
        [3750.0, 110.0, 0.0],
        [0.0, 110.0, 0.0],
        [0.0, 110.0, 80.0],
    ];
    let faces = [
        [0, 1, 2],
        [3, 4, 5],
        [5, 6, 7],
        [8, 9, 10],
        [10, 0, 2],
        [5, 7, 11],
        [8, 10, 2],
        [3, 5, 11],
        [11, 8, 2],
        [2, 3, 11],
        [3, 2, 12],
        [3, 12, 13],
        [4, 3, 13],
        [4, 13, 14],
        [4, 14, 15],
        [4, 15, 5],
        [5, 15, 16],
        [5, 16, 6],
        [17, 7, 6],
        [17, 6, 16],
        [11, 7, 17],
        [11, 17, 18],
        [8, 11, 18],
        [8, 18, 19],
        [20, 9, 8],
        [20, 8, 19],
        [9, 20, 21],
        [9, 21, 10],
        [21, 22, 0],
        [21, 0, 10],
        [23, 1, 0],
        [23, 0, 22],
        [2, 1, 23],
        [2, 23, 12],
        [12, 23, 22],
        [22, 21, 20],
        [18, 17, 16],
        [16, 15, 14],
        [22, 20, 19],
        [16, 14, 13],
        [12, 22, 19],
        [18, 16, 13],
        [13, 12, 19],
        [19, 18, 13],
    ];
    let tris: Vec<Tri> = faces.iter().map(|t| t.map(|i| vertices[i])).collect();
    crate::kernel::mesh_bridge::tris_to_mesh(&tris)
}

fn bottom_cutter_7292() -> crate::Mesh {
    let vertices = [
        [0.0, 110.0, 80.0],
        [3749.999755859375, 110.0, 80.0],
        [3750.0, 110.0, 0.0],
        [0.0, 110.0, 0.0],
        [3749.999755859375, 20.0, 80.0],
        [0.0, 20.0, 80.0],
        [3750.0, 20.0, 0.0],
        [0.0, 20.0, 0.0],
    ];
    let faces = [
        [0, 1, 2],
        [0, 2, 3],
        [4, 1, 0],
        [4, 0, 5],
        [1, 4, 6],
        [1, 6, 2],
        [6, 7, 3],
        [6, 3, 2],
        [5, 0, 3],
        [5, 3, 7],
        [4, 5, 7],
        [4, 7, 6],
    ];
    let tris: Vec<Tri> = faces.iter().map(|t| t.map(|i| vertices[i])).collect();
    crate::kernel::mesh_bridge::tris_to_mesh(&tris)
}

/// Independent output measurement: intersect an axis-parallel line with mesh
/// triangles using projected barycentric coordinates. The chosen probes lie
/// strictly inside their faces, so shared triangle edges cannot double-count.
fn axis_hits_7292(mesh: &crate::Mesh, axis: usize, point: [f64; 3]) -> Vec<f64> {
    let axes: Vec<_> = (0..3).filter(|&k| k != axis).collect();
    let (x, y) = (axes[0], axes[1]);
    let mut hits = Vec::new();
    for ids in mesh.indices.chunks_exact(3) {
        let t = [ids[0], ids[1], ids[2]].map(|i| {
            [0, 1, 2].map(|k| f64::from(mesh.positions[i as usize * 3 + k]))
        });
        let u = [0, 1, 2].map(|k| t[1][k] - t[0][k]);
        let v = [0, 1, 2].map(|k| t[2][k] - t[0][k]);
        let det = u[x] * v[y] - u[y] * v[x];
        if det == 0.0 { continue; }
        let dx = point[x] - t[0][x];
        let dy = point[y] - t[0][y];
        let alpha = (dx * v[y] - dy * v[x]) / det;
        let beta = (u[x] * dy - u[y] * dx) / det;
        if alpha > 0.0 && beta > 0.0 && alpha + beta < 1.0 {
            hits.push(t[0][axis] + alpha * u[axis] + beta * v[axis]);
        }
    }
    hits.sort_by(f64::total_cmp);
    hits
}

#[test]
fn issue_7292_real_cut_has_one_front_boundary_and_retains_the_next_bottom_cap() {
    use crate::csg::{ClippingProcessor, GroupCut};
    let _caps = budget::GLOBAL_CAP_LOCK.lock().unwrap();
    let _test_caps = budget::test_caps::scope();
    let _element = budget::enter_element();
    budget::begin();
    let host = cut0_host_7292();
    let clipper = ClippingProcessor::with_unit_scale(0.001);
    let first = match clipper.subtract_mesh(&host, &cut0_cutter_7292()) {
        GroupCut::Cut(mesh) => mesh,
        GroupCut::Retessellated(_) => panic!("the tilted front really removes material"),
        GroupCut::Rejected(reason) => panic!("first captured cut rejected: {reason:?}"),
    };
    assert!(!budget::tripped());
    // At this X/Z the tilted cutter's front lies strictly inside the original
    // Y110 wall. Difference must expose only that front, not also the old wall.
    let z = 609.4444444444445;
    let expected_y = 110.0 + (z - 80.0) / (2715.0 - 80.0) * (109.99946594238281 - 110.0);
    let front: Vec<_> = axis_hits_7292(&first, 1, [1855.0, 0.0, z]).into_iter()
        .filter(|&y| (109.9..110.1).contains(&y)).collect();
    assert_eq!(front.len(), 1, "retain one tilted front boundary, without the interior Y110 copy");
    // Local f32 evaluation allowance: 0.00002 mm (20 nm), smaller than the
    // 107 nm separation from the spurious Y110 sheet at this probe. Boundary
    // multiplicity above uses strict interior hits with no epsilon or dedup.
    assert!((front[0] - expected_y).abs() < 0.00002, "retain the actual cutter front");
    let second = match clipper.subtract_mesh(&first, &bottom_cutter_7292()) {
        GroupCut::Cut(mesh) => mesh,
        GroupCut::Retessellated(_) => panic!("the bottom prism really removes material"),
        GroupCut::Rejected(reason) => panic!("second captured cut rejected: {reason:?}"),
    };
    assert!(!budget::tripped());
    let vertical = axis_hits_7292(&second, 2, [5575.0 / 3.0, 80.0, 0.0]);
    assert_eq!(vertical.len(), 2, "retain the required bottom cap and upper boundary");
    assert!((vertical[0] - 80.0).abs() < 0.001, "the second cut must retain its required Z80 cap");
    assert!((vertical[1] - 3250.0).abs() < 0.001);
}

#[test]
fn issue_7292_actual_489647_near_face_cannot_own_a_cell_outside_its_finite_outline() {
    let _caps = budget::GLOBAL_CAP_LOCK.lock().unwrap();
    let _test_caps = budget::test_caps::scope();
    let _element = budget::enter_element();
    budget::begin();
    // Actual last job004 A4/sourceparent0 versus promoted B11. The centroid
    // is finite-near and all vertices fit the unchanged band, but A4's second
    // vertex lies outside B11. That whole-cell ownership dropped required A.
    let own = [[95.0, 12000.0, -325.0], [95.0, 11945.0, -320.0], [95.0, 12000.0, -320.0]];
    let other = [[[95.00016784667969, 11845.0, -325.0],
        [95.0, 12000.0, -320.0], [95.0, 12000.0, -325.0]]];
    let c = [95.0, 35945.0 / 3.0, -965.0 / 3.0];
    let n_own = [-275.0, 0.0, 0.0];
    let exact = own.map(e);
    let band = NearBand::from_operands(&[own], &other);
    let n = near_on_surface_tri(c, &other[0], &band).expect("old centroid-near eligibility");
    assert!(own.iter().all(|&p| {
        let d = dot3(sub_f64(p, other[0][0]), n);
        d * d <= band.scaled_band2(n, dot3(n, n))
    }), "original whole-cell band must remain eligible");
    assert!(on_surface_normal(c, n_own, &other).is_none(), "this exercises near, not exact shared ownership");
    assert!(near_on_surface_normal(c, n_own, &own, exact.each_ref(), &other, &band, &std::cell::OnceCell::new()).is_none());
    assert!(!has_nonopposed_surface(c, n_own, &own, exact.each_ref(), &other, &band, &std::cell::OnceCell::new()));
    let tree = crate::kernel::broadphase::Bvh::build(&other);
    assert!(surface_normal_near_a(c, n_own, &own, exact.each_ref(), &other, &tree, &band, &mut Vec::new(), &std::cell::OnceCell::new()).is_none());
    let components = [&other[..]];
    let bc = super::super::BComponents::new(&components);
    assert!(bc.surface_normal(c, n_own, &own, exact.each_ref(), &[band]).is_none());
    assert!(!budget::tripped());
}

#[test]
fn issue_7292_symbolic_boundary_point_must_not_be_tested_as_rounded_f64() {
    let _caps = budget::GLOBAL_CAP_LOCK.lock().unwrap();
    let _test_caps = budget::test_caps::scope();
    let _element = budget::enter_element();
    budget::begin();
    use crate::kernel::{rational::point_of, Lpi};
    use num_traits::ToPrimitive;
    let gap = 1.0 / 65536.0;
    // Exact (1,1/3,gap) on the projected edge from(0,0) to(3,1).
    // Materializing1/3 rounds below that edge: a new f64-only guard would
    // incorrectly discard this valid shared patch (the reporter failure class).
    let points = [ImplicitPoint::Lpi(Lpi {
        p: [0.0, 0.0, gap], q: [3.0, 1.0, gap],
        r: [1.0, 0.0, 0.0], s: [1.0, 1.0, 0.0], t: [1.0, 0.0, 1.0],
    }), e([1.0, 1.0, gap]), e([0.5, 1.0, gap])];
    let own = points.each_ref().map(|p| point_of(p).map(|v| v.to_f64().unwrap()));
    let other = [[[0.0, 0.0, 0.0], [3.0, 1.0, 0.0], [0.0, 3.0, 0.0]]];
    let n_own = cross3(sub_f64(own[1], own[0]), sub_f64(own[2], own[0]));
    let n_other = [0.0, 0.0, 9.0];
    assert!(symbolic_point_in_tri_proj(&points[0], &other[0], n_other));
    assert!(!point_in_tri_proj(own[0], &other[0], n_other), "the actual rounded point is strictly outside");
    let c = std::array::from_fn(|k| (own[0][k] + own[1][k] + own[2][k]) / 3.0);
    let band = NearBand::from_operands(&[own], &other);
    assert!(on_surface_normal(c, n_own, &other).is_none());
    assert!(near_on_surface_normal(c, n_own, &own, points.each_ref(), &other, &band, &std::cell::OnceCell::new()).is_some());
    assert!(has_nonopposed_surface(c, n_own, &own, points.each_ref(), &other, &band, &std::cell::OnceCell::new()));
    let tree = crate::kernel::broadphase::Bvh::build(&other);
    assert!(surface_normal_near_a(c, n_own, &own, points.each_ref(), &other, &tree, &band, &mut Vec::new(), &std::cell::OnceCell::new()).is_some());
    let components = [&other[..]];
    let bc = super::super::BComponents::new(&components);
    assert!(bc.surface_normal(c, n_own, &own, points.each_ref(), &[band]).is_some());
    assert!(!budget::tripped());
}
