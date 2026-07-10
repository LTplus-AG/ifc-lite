//! Golden tests ported from
//! /Users/louistrue/Development/ifc-lite-plato/rust/clash/src/tests.rs.
//!
//! Only the tests exercising the vec3/aabb/triangle-intersect layer are
//! portable: the tri-tri SAT trio is ported verbatim; the aabb-layer semantics
//! (signed gap, touch, clearance, containment, overlap bounds) are ported at
//! the box level using the exact AABB fixtures from the session tests
//! (unit_cube / sized_cube / box_hxyz / tri_prism), because tests.rs exercises
//! the boxes only through ClashSession which sits above the layer under test.
//!
//! NOT portable: `tritri_distance_parallel_gap` and `tritri_distance_touching`
//! (tri_tri_distance has no counterpart in the generated plato surface).
//!
//! Every scenario runs against BOTH the adapter (plato-backed) and the
//! hand-written reference, asserting identical (bit-exact) results.

use clash_validate_rust::adapter;
use clash_validate_rust::reference::aabb as raabb;
use clash_validate_rust::reference::triangle as rtri;

type V3 = [f64; 3];

fn ref_box(min: V3, max: V3) -> raabb::Aabb {
    raabb::Aabb::new(min, max)
}

fn ad_box(min: V3, max: V3) -> adapter::Aabb {
    adapter::Aabb::new(min, max)
}

/// f64 AABB of the `unit_cube(cx, cy, cz)` fixture (side 1).
fn cube_bounds(cx: f64, cy: f64, cz: f64) -> (V3, V3) {
    let h = 0.5;
    ([cx - h, cy - h, cz - h], [cx + h, cy + h, cz + h])
}

/// f64 AABB of the `sized_cube(cx, cy, cz, side)` fixture.
fn sized_bounds(cx: f64, cy: f64, cz: f64, side: f64) -> (V3, V3) {
    let h = side / 2.0;
    ([cx - h, cy - h, cz - h], [cx + h, cy + h, cz + h])
}

fn assert_bits_eq(a: f64, b: f64, what: &str) {
    assert_eq!(
        a.to_bits(),
        b.to_bits(),
        "{what}: adapter={a:?} ({:#018x}) reference={b:?} ({:#018x})",
        a.to_bits(),
        b.to_bits()
    );
}

fn assert_box_bits_eq(a: &adapter::Aabb, b: &raabb::Aabb, what: &str) {
    for i in 0..3 {
        assert_bits_eq(a.min[i], b.min[i], &format!("{what}.min[{i}]"));
        assert_bits_eq(a.max[i], b.max[i], &format!("{what}.max[{i}]"));
    }
}

// --- Triangle math golden tests (direct ports) --------------------------------

#[test]
fn tritri_intersect_piercing() {
    // Triangle A in the z=0 plane; triangle B pierces straight through it.
    let a0: V3 = [-1.0, -1.0, 0.0];
    let a1: V3 = [1.0, -1.0, 0.0];
    let a2: V3 = [0.0, 1.0, 0.0];
    let b0: V3 = [0.0, 0.0, -1.0];
    let b1: V3 = [0.0, 0.0, 1.0];
    let b2: V3 = [0.5, 0.5, 0.0];
    let r = rtri::tri_tri_intersect(a0, a1, a2, b0, b1, b2);
    let p = adapter::tri_tri_intersect(a0, a1, a2, b0, b1, b2);
    assert!(r, "reference: piercing should intersect");
    assert!(p, "adapter/plato: piercing should intersect");
    assert_eq!(p, r, "adapter and reference must agree");
}

#[test]
fn tritri_intersect_separated() {
    let a0: V3 = [-1.0, -1.0, 0.0];
    let a1: V3 = [1.0, -1.0, 0.0];
    let a2: V3 = [0.0, 1.0, 0.0];
    // Same triangle translated +2 in z: clearly separated.
    let b0: V3 = [-1.0, -1.0, 2.0];
    let b1: V3 = [1.0, -1.0, 2.0];
    let b2: V3 = [0.0, 1.0, 2.0];
    let r = rtri::tri_tri_intersect(a0, a1, a2, b0, b1, b2);
    let p = adapter::tri_tri_intersect(a0, a1, a2, b0, b1, b2);
    assert!(!r, "reference: separated should not intersect");
    assert!(!p, "adapter/plato: separated should not intersect");
    assert_eq!(p, r, "adapter and reference must agree");
}

#[test]
fn tritri_intersect_coincident() {
    // Identical coplanar triangles: coplanar overlap is treated as touching,
    // i.e. NOT a hard intersection.
    let a0: V3 = [-1.0, -1.0, 0.0];
    let a1: V3 = [1.0, -1.0, 0.0];
    let a2: V3 = [0.0, 1.0, 0.0];
    let r = rtri::tri_tri_intersect(a0, a1, a2, a0, a1, a2);
    let p = adapter::tri_tri_intersect(a0, a1, a2, a0, a1, a2);
    assert!(!r, "reference: coincident should not intersect");
    assert!(!p, "adapter/plato: coincident should not intersect");
    assert_eq!(p, r, "adapter and reference must agree");
}

// --- AABB golden scenarios (box level of the session tests) -------------------

#[test]
fn overlapping_cubes_penetration_and_overlap_bounds() {
    // Mirrors `overlapping_cubes_hard`: cubes at (0,0,0) and (0.5,0,0).
    // Overlap region is 0.5 x 1 x 1 and the boxes interpenetrate.
    let (amin, amax) = cube_bounds(0.0, 0.0, 0.0);
    let (bmin, bmax) = cube_bounds(0.5, 0.0, 0.0);
    let (ra, rb) = (ref_box(amin, amax), ref_box(bmin, bmax));
    let (pa, pb) = (ad_box(amin, amax), ad_box(bmin, bmax));

    assert!(ra.intersects(&rb));
    assert_eq!(pa.intersects(&pb), ra.intersects(&rb), "intersects must agree");

    let rg = raabb::signed_gap(&ra, &rb);
    let pg = adapter::signed_gap(&pa, &pb);
    assert!(rg < 0.0, "penetration distance must be negative, got {rg}");
    assert_bits_eq(pg, rg, "signed_gap(overlapping cubes)");

    let rov = raabb::overlap_bounds(&ra, &rb);
    let pov = adapter::overlap_bounds(&pa, &pb);
    assert_box_bits_eq(&pov, &rov, "overlap_bounds(overlapping cubes)");
    // The visible-penetration-box assertion from the golden test: 0.5 x 1 x 1.
    let dx = rov.max[0] - rov.min[0];
    let dy = rov.max[1] - rov.min[1];
    let dz = rov.max[2] - rov.min[2];
    assert!(
        dx > 0.4 && dx < 0.6 && dy > 0.5 && dz > 0.5,
        "overlap region must be a visible box, got {dx}x{dy}x{dz}"
    );
}

#[test]
fn separated_cubes_gap_and_clearance() {
    // Mirrors `separated_cubes_hard_none` + `separated_cubes_clearance_hit/miss`:
    // cubes at x=0 and x=2 -> faces at 0.5 and 1.5 -> gap 1.0.
    let (amin, amax) = cube_bounds(0.0, 0.0, 0.0);
    let (bmin, bmax) = cube_bounds(2.0, 0.0, 0.0);
    let (ra, rb) = (ref_box(amin, amax), ref_box(bmin, bmax));
    let (pa, pb) = (ad_box(amin, amax), ad_box(bmin, bmax));

    assert!(!ra.intersects(&rb), "separated cubes must not intersect");
    assert_eq!(pa.intersects(&pb), ra.intersects(&rb), "intersects must agree");

    let rg = raabb::signed_gap(&ra, &rb);
    let pg = adapter::signed_gap(&pa, &pb);
    assert!((rg - 1.0).abs() < 1e-6, "gap should be ~1.0, got {rg}");
    assert!(rg <= 1.5, "clearance 1.5 should report the gap");
    assert!(rg > 0.5, "clearance 0.5 < gap 1.0 -> no record");
    assert_bits_eq(pg, rg, "signed_gap(separated cubes)");
}

#[test]
fn touching_faces_zero_gap() {
    // Mirrors `touching_faces_no_touch_report` / `_with_touch_report`: cubes at
    // x=0 and x=1 share the x=0.5 face -> contact (gap 0), not penetration.
    let (amin, amax) = cube_bounds(0.0, 0.0, 0.0);
    let (bmin, bmax) = cube_bounds(1.0, 0.0, 0.0);
    let (ra, rb) = (ref_box(amin, amax), ref_box(bmin, bmax));
    let (pa, pb) = (ad_box(amin, amax), ad_box(bmin, bmax));

    assert!(ra.intersects(&rb), "touching AABBs count as intersecting (<=)");
    assert_eq!(pa.intersects(&pb), ra.intersects(&rb), "intersects must agree");

    let rg = raabb::signed_gap(&ra, &rb);
    let pg = adapter::signed_gap(&pa, &pb);
    assert!(rg == 0.0, "touch must have zero gap, got {rg}");
    assert!(!(rg < 0.0), "touch must not read as penetration");
    assert_bits_eq(pg, rg, "signed_gap(touching faces)");
}

#[test]
fn enclosed_solid_containment() {
    // Mirrors `enclosed_solid_hard`: a side-1 cube fully inside a side-10 cube.
    let (omin, omax) = sized_bounds(0.0, 0.0, 0.0, 10.0);
    let (imin, imax) = sized_bounds(0.0, 0.0, 0.0, 1.0);
    let (router, rinner) = (ref_box(omin, omax), ref_box(imin, imax));
    let (pouter, pinner) = (ad_box(omin, omax), ad_box(imin, imax));

    assert!(raabb::aabb_contains(&router, &rinner), "outer must contain inner");
    assert_eq!(
        adapter::aabb_contains(&pouter, &pinner),
        raabb::aabb_contains(&router, &rinner),
        "aabb_contains must agree"
    );

    let rg = raabb::signed_gap(&router, &rinner);
    let pg = adapter::signed_gap(&pouter, &pinner);
    assert!(rg < 0.0, "enclosed solid must read as penetration, got {rg}");
    assert_bits_eq(pg, rg, "signed_gap(enclosed)");
}

#[test]
fn separated_not_enclosed() {
    // Mirrors `separated_not_enclosed_none`: two side-1 cubes far apart, neither
    // AABB contains the other.
    let (amin, amax) = sized_bounds(0.0, 0.0, 0.0, 1.0);
    let (bmin, bmax) = sized_bounds(20.0, 0.0, 0.0, 1.0);
    let (ra, rb) = (ref_box(amin, amax), ref_box(bmin, bmax));
    let (pa, pb) = (ad_box(amin, amax), ad_box(bmin, bmax));

    assert!(!raabb::aabb_contains(&ra, &rb));
    assert!(!raabb::aabb_contains(&rb, &ra));
    assert_eq!(adapter::aabb_contains(&pa, &pb), raabb::aabb_contains(&ra, &rb));
    assert_eq!(adapter::aabb_contains(&pb, &pa), raabb::aabb_contains(&rb, &ra));
    assert!(!ra.intersects(&rb), "disjoint cubes must not intersect");
    assert_eq!(pa.intersects(&pb), ra.intersects(&rb));
}

#[test]
fn skewed_prism_aabbs_overlap() {
    // Mirrors the fixture-sanity assertion in `skewed_face_touch_no_false_hard`:
    // the two wedge AABBs (tri_prism fixtures) fully overlap in A's footprint.
    // A: footprint (0,0),(2,0),(0,2), z 0..1 -> [0,0,0]-[2,2,1].
    // B: footprint (2,0),(0,2),(5,5), z 0..1 -> [0,0,0]-[5,5,1].
    let (ra, rb) = (
        ref_box([0.0, 0.0, 0.0], [2.0, 2.0, 1.0]),
        ref_box([0.0, 0.0, 0.0], [5.0, 5.0, 1.0]),
    );
    let (pa, pb) = (
        ad_box([0.0, 0.0, 0.0], [2.0, 2.0, 1.0]),
        ad_box([0.0, 0.0, 0.0], [5.0, 5.0, 1.0]),
    );
    assert!(ra.intersects(&rb), "fixture invalid: AABBs must overlap");
    assert_eq!(pa.intersects(&pb), ra.intersects(&rb), "intersects must agree");
}

#[test]
fn crossing_bars_overlap_bounds_are_tight() {
    // Mirrors `crossing_hard_bounds_are_tight` at the box level: bar A along X,
    // bar B along Y (box_hxyz fixtures). The element-overlap AABB is the local
    // crossing region x[-0.5,0.5] y[-0.5,0.5] z[-0.5,0.5].
    let (ra, rb) = (
        ref_box([-5.0, -0.5, -0.5], [5.0, 0.5, 0.5]),
        ref_box([-0.5, -5.0, -0.5], [0.5, 5.0, 0.5]),
    );
    let (pa, pb) = (
        ad_box([-5.0, -0.5, -0.5], [5.0, 0.5, 0.5]),
        ad_box([-0.5, -5.0, -0.5], [0.5, 5.0, 0.5]),
    );

    let rov = raabb::overlap_bounds(&ra, &rb);
    let pov = adapter::overlap_bounds(&pa, &pb);
    assert_box_bits_eq(&pov, &rov, "overlap_bounds(crossing bars)");

    // Tight along the long bar: the overlap must NOT span A's 10 m length.
    let bounds_x = rov.max[0] - rov.min[0];
    assert!(bounds_x < 2.0, "overlap must be local, got {bounds_x}");
    for axis in 0..3 {
        let overlap_min = ra.min[axis].max(rb.min[axis]);
        let overlap_max = ra.max[axis].min(rb.max[axis]);
        assert!(
            rov.min[axis] >= overlap_min - 1e-6 && rov.max[axis] <= overlap_max + 1e-6,
            "overlap bounds escape the element-overlap AABB on axis {axis}"
        );
    }
}

#[test]
fn aligned_unequal_overlap_penetration() {
    // Mirrors `aligned_unequal_overlap_still_hard` at the box level:
    // a x[-5,5], b x[4.9,5.9] (box_hxyz(5.4, ..., 0.5)) -> genuine small overlap.
    let (ra, rb) = (
        ref_box([-5.0, -0.5, -0.5], [5.0, 0.5, 0.5]),
        ref_box([4.9, -0.5, -0.5], [5.9, 0.5, 0.5]),
    );
    let (pa, pb) = (
        ad_box([-5.0, -0.5, -0.5], [5.0, 0.5, 0.5]),
        ad_box([4.9, -0.5, -0.5], [5.9, 0.5, 0.5]),
    );

    assert!(ra.intersects(&rb));
    assert_eq!(pa.intersects(&pb), ra.intersects(&rb));

    let rg = raabb::signed_gap(&ra, &rb);
    let pg = adapter::signed_gap(&pa, &pb);
    assert!(rg < 0.0, "genuine overlap must be penetration, got {rg}");
    assert_bits_eq(pg, rg, "signed_gap(aligned unequal overlap)");

    let rov = raabb::overlap_bounds(&ra, &rb);
    let pov = adapter::overlap_bounds(&pa, &pb);
    assert_box_bits_eq(&pov, &rov, "overlap_bounds(aligned unequal overlap)");
    let dx = rov.max[0] - rov.min[0];
    assert!((dx - 0.1).abs() < 1e-9, "overlap depth should be ~0.1, got {dx}");
}
