// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Native unit tests for `mesh.rs` / `mesh_fingerprint.rs`. The `js_sys`
//! typed-array GETTERS need a JS environment, so these exercise the backing
//! buffers directly — which is where the contract that matters lives: the five
//! geometry-diff arrays are read by index, so any length skew mis-attributes
//! every entry after it.

use super::{GeometryFingerprint, MeshCollection, MeshDataJs};
use ifc_lite_geometry::Mesh;

fn fp(express_id: u32, hash: u64, aabb: Option<[f64; 6]>) -> GeometryFingerprint {
    GeometryFingerprint {
        express_id,
        hash,
        aabb,
        volume: None,
        closure_bits: 0,
    }
}

#[test]
fn geometry_diff_arrays_stay_index_parallel() {
    let mut c = MeshCollection::new();
    c.push_geometry_hash(fp(7, 111, Some([0.0, 1.0, 2.0, 3.0, 4.0, 5.0])));
    c.push_geometry_hash(fp(9, 222, Some([-1.0, -2.0, -3.0, 10.0, 20.0, 30.0])));

    assert_eq!(c.geometry_hash_ids, vec![7, 9]);
    assert_eq!(c.geometry_hash_values, vec![111, 222]);
    assert_eq!(c.geometry_aabb_values.len(), 2 * 6);
    assert_eq!(&c.geometry_aabb_values[6..], &[-1.0, -2.0, -3.0, 10.0, 20.0, 30.0]);
    assert_eq!(c.geometry_volume_values.len(), 2, "one volume slot per id");
    assert_eq!(c.geometry_closure_flags.len(), 2, "one flag byte per id");
}

/// A hash with no box must still occupy its six slots. Shortening the array
/// instead would silently shift every LATER entity's box onto the wrong id —
/// the failure mode is wrong answers, not a crash, so it is pinned here.
#[test]
fn a_missing_box_reserves_its_slots_instead_of_shifting_the_array() {
    let mut c = MeshCollection::new();
    c.push_geometry_hash(fp(1, 10, None));
    c.push_geometry_hash(fp(2, 20, Some([1.0, 2.0, 3.0, 4.0, 5.0, 6.0])));

    assert_eq!(c.geometry_aabb_values.len(), 12, "one 6-slot span per id");
    assert!(
        c.geometry_aabb_values[..6].iter().all(|v| v.is_nan()),
        "the absent box must read as NaN, not as a box at the origin"
    );
    assert_eq!(&c.geometry_aabb_values[6..], &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
}

/// The same rule for the volume, which is absent far more often than the box is
/// (most entities are not a provably closed single solid). A zero would read as
/// "this element encloses nothing", which is a claim; NaN is the absence of one.
#[test]
fn an_absent_volume_is_nan_not_zero_and_keeps_its_slot() {
    let mut c = MeshCollection::new();
    c.push_geometry_hash(GeometryFingerprint {
        express_id: 1,
        hash: 10,
        aabb: Some([0.0; 6]),
        volume: None,
        closure_bits: 0b0111,
    });
    c.push_geometry_hash(GeometryFingerprint {
        express_id: 2,
        hash: 20,
        aabb: Some([0.0; 6]),
        volume: Some(2.5),
        closure_bits: 0b1111,
    });

    assert_eq!(c.geometry_volume_values.len(), 2, "one slot per id, always");
    assert!(
        c.geometry_volume_values[0].is_nan(),
        "an absent volume must be NaN — 0.0 would assert that the element encloses nothing"
    );
    assert_eq!(c.geometry_volume_values[1], 2.5);
    assert_eq!(
        c.geometry_closure_flags,
        vec![0b0111, 0b1111],
        "the flags say WHICH clause refused, so they must survive verbatim"
    );
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
        assert!(c.geometry_volume_values.is_empty());
        assert!(c.geometry_closure_flags.is_empty());
    }
}

/// `Clone` is how a batch hands its results on; every parallel array must ride
/// with the ids rather than being dropped.
#[test]
fn clone_carries_every_parallel_array() {
    let mut c = MeshCollection::new();
    c.push_geometry_hash(GeometryFingerprint {
        express_id: 5,
        hash: 55,
        aabb: Some([0.5; 6]),
        volume: Some(7.25),
        closure_bits: 0b1111,
    });
    let cloned = c.clone();
    assert_eq!(cloned.geometry_hash_ids, vec![5]);
    assert_eq!(cloned.geometry_aabb_values, vec![0.5; 6]);
    assert_eq!(cloned.geometry_volume_values, vec![7.25]);
    assert_eq!(cloned.geometry_closure_flags, vec![0b1111]);
}

/// `MeshDataJs::new` reverses winding order in place-of-3 triples to
/// compensate for the Z-up->Y-up handedness flip. A caller-supplied index
/// count that is not a multiple of 3 must not panic — the divisible prefix is
/// processed and the (malformed) remainder is left untouched, rather than the
/// bounds computation reading past the end of `indices`.
#[test]
fn new_processes_divisible_prefix_without_panicking_on_non_multiple_of_3_indices() {
    let mut mesh = Mesh::new();
    mesh.positions = vec![0.0, 0.0, 1.0, 0.0, 1.0, 2.0];
    mesh.normals = vec![0.0, 0.0, 1.0, 0.0, 1.0, 0.0];
    mesh.indices = vec![0, 1, 0, 1]; // 4 indices: not a multiple of 3

    let md = MeshDataJs::new(1, "IfcWall".to_string(), mesh, [1.0, 1.0, 1.0, 1.0]);

    // Only the first 3 (divisible prefix) are winding-reversed via swap(1, 2);
    // the trailing 4th index rides through unchanged.
    assert_eq!(md.indices, vec![0, 0, 1, 1]);
}

/// `MeshDataJs::new` converts IFC Z-up to WebGL Y-up: new_y = old_z,
/// new_z = -old_y, for both positions and normals.
#[test]
fn new_converts_zup_to_yup_for_positions_and_normals() {
    let mut mesh = Mesh::new();
    mesh.positions = vec![1.0, 2.0, 3.0];
    mesh.normals = vec![0.0, 1.0, 0.0];
    mesh.indices = vec![0, 0, 0];

    let md = MeshDataJs::new(1, "IfcWall".to_string(), mesh, [1.0, 1.0, 1.0, 1.0]);

    assert_eq!(md.positions, vec![1.0, 3.0, -2.0]);
    assert_eq!(md.normals, vec![0.0, 0.0, -1.0]);
}

/// `MeshDataJs::new` must apply the SAME IFC Z-up -> WebGL Y-up swap to
/// `origin`, `local_bounds` and `local_to_world` as it does to `positions`
/// (issue #1474). Nothing previously pinned this: a mutation dropping any of
/// the three swaps (origin left un-swapped, local_bounds passed through
/// unconverted, local_to_world left un-conjugated) survived the full suite —
/// `world = origin + position` would then mix axes and every consumer of
/// `localBounds`/`localToWorld` would receive IFC-frame data in a Y-up scene
/// (mirrored / displaced local-frame geometry).
#[test]
fn new_converts_origin_local_bounds_and_local_to_world_to_yup() {
    let mut mesh = Mesh::new();
    mesh.positions = vec![0.0, 0.0, 0.0];
    mesh.normals = vec![0.0, 0.0, 1.0];
    mesh.indices = vec![0, 0, 0];
    // origin: IFC (x,y,z) -> Y-up (x,z,-y)
    mesh.origin = [10.0, 20.0, 30.0];
    // local_bounds: [minx,miny,minz,maxx,maxy,maxz], IFC frame
    mesh.local_bounds = Some([1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
    // local_to_world: identity except a translation, so the swap is easy to
    // verify by hand: the translation column (row-major, col 3) is the same
    // per-component (x,z,-y) swap as `origin`.
    #[rustfmt::skip]
    let m = [
        1.0, 0.0, 0.0, 100.0,
        0.0, 1.0, 0.0, 200.0,
        0.0, 0.0, 1.0, 300.0,
        0.0, 0.0, 0.0, 1.0,
    ];
    mesh.local_to_world = Some(m);

    let md = MeshDataJs::new(1, "IfcWall".to_string(), mesh, [1.0, 1.0, 1.0, 1.0]);

    // origin: (10, 20, 30) -> (10, 30, -20)
    assert_eq!(md.origin, [10.0, 30.0, -20.0]);

    // local_bounds: min_y/max_y swap-and-negate onto the new Z, per
    // `swap_zup_to_yup_aabb` (NOT a plain per-component swap).
    assert_eq!(
        md.local_bounds,
        Some([1.0, 3.0, -5.0, 4.0, 6.0, -2.0]),
        "local_bounds must go through the AABB-corner swap, not a per-component one"
    );

    // local_to_world translation column: (100, 200, 300) -> (100, 300, -200),
    // the same swap as a plain point, confirming M' = S*M*S^T carries the
    // translation through correctly for this diagonal-plus-translation case.
    let ltw = md.local_to_world.expect("local_to_world set");
    assert_eq!([ltw[3], ltw[7], ltw[11]], [100.0, 300.0, -200.0]);
}
