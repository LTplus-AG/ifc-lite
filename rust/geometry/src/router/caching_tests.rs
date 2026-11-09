// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `caching.rs`, in a sibling file so the module itself stays
//! inside its `module_size_ratchet` budget (the house pattern; `_tests.rs`
//! files are ratchet-exempt).

use super::*;
use crate::router::GeometryRouter;

/// Issue #833 regression. Two distinct meshes that happen to share
/// the same `compute_mesh_hash` output must not be deduped — the
/// previous hash-only-equality cache caused slab #783200 in
/// schependomlaan.ifc to inherit the local mesh of slab #605217
/// because both rectangular profiles hashed identically under
/// wasm32 codegen.
///
/// We can't easily reproduce the wasm32 hash collision in a native
/// unit test, so we forge one: build a second `Mesh` that differs
/// from the first only in position data, manually insert it into
/// the cache under the *first* mesh's hash, and assert
/// `get_or_cache_by_hash` falls through to a fresh `Arc` instead of
/// silently returning the wrong cached mesh.
#[test]
fn collision_does_not_silently_swap_meshes() {
    let router = GeometryRouter::new();
    let mut mesh_a = Mesh::new();
    mesh_a.positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    mesh_a.indices = vec![0, 1, 2];
    mesh_a.normals = vec![0.0; 9];
    let mut mesh_b = Mesh::new();
    // Mirror of mesh_a about the X axis — distinct geometry that
    // *would* render at the wrong place if the cache returned A in
    // place of B.
    mesh_b.positions = vec![0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, -1.0, 0.0];
    mesh_b.indices = vec![0, 1, 2];
    mesh_b.normals = vec![0.0; 9];

    // Force a "collision" by inserting mesh_a under mesh_b's hash.
    let collision_hash = GeometryRouter::compute_mesh_hash(&mesh_b);
    let cached_a = Arc::new(mesh_a.clone());
    router
        .geometry_hash_cache
        .borrow_mut()
        .insert(collision_hash, Arc::clone(&cached_a));

    let returned = router.get_or_cache_by_hash(mesh_b.clone());
    // Pre-fix: returned would be `Arc::clone(&cached_a)` (wrong
    // mesh!). Post-fix: returned is a fresh Arc wrapping mesh_b.
    assert_eq!(
        returned.positions, mesh_b.positions,
        "cache returned mesh_a after hash collision — issue #833 regression",
    );
    assert!(
        !Arc::ptr_eq(&returned, &cached_a),
        "cache returned the same Arc as the collision-inserted entry",
    );
}

/// Two one-triangle meshes that share their positions and indices and
/// differ ONLY in the normals given. Sharing the positions is what makes
/// the pair collide on `compute_mesh_hash`, which is the premise of every
/// test below, so it is built once here rather than per test.
fn pair_differing_only_in_normals(left: Vec<f32>, right: Vec<f32>) -> (Mesh, Mesh) {
    let build = |normals: Vec<f32>| {
        let mut mesh = Mesh::new();
        mesh.positions = vec![0.0, 0.0, 0.0, 1.2, 0.0, 0.0, 1.2, 0.7, 0.0];
        mesh.indices = vec![0, 1, 2];
        mesh.normals = normals;
        mesh
    };
    (build(left), build(right))
}

/// The #8276 pair, at the real model's magnitudes: one rectangular opening
/// whose ring is exactly axis-aligned, and one whose top edge sits 1e-15
/// off, which gives a side-wall normal a ~1e-15 component where the first
/// has an exact zero. `meshes_equal` says why that pair exists.
fn normals_only_pair() -> (Mesh, Mesh) {
    pair_differing_only_in_normals(
        vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
        vec![1.0e-15, 0.0, 1.0, 1.0e-15, 0.0, 1.0, 1.0e-15, 0.0, 1.0],
    )
}

/// Issue #8276 regression, cache half: the second item must come back with
/// its OWN normals. The pair genuinely collides, so unlike
/// `collision_does_not_silently_swap_meshes` nothing here is forged.
#[test]
fn normals_only_difference_is_not_deduped() {
    let router = GeometryRouter::new();
    let (exact, tilted) = normals_only_pair();
    assert_eq!(
        GeometryRouter::compute_mesh_hash(&exact),
        GeometryRouter::compute_mesh_hash(&tilted),
        "fixture rot: the two meshes no longer collide, so this test proves nothing",
    );

    let _ = router.get_or_cache_by_hash(exact);
    let second = router.get_or_cache_by_hash(tilted.clone());
    assert_eq!(
        second.normals, tilted.normals,
        "cache served another item's normals for an f32-identical mesh (#8276)",
    );
}

/// Issue #8276 regression, signed-zero half. `meshes_equal` says why a
/// `-0.0` normal is a real difference that `f32::eq` cannot see. Asserted
/// on the sign bit rather than through `f32_bits_eq`, so the fix is not
/// judged by its own comparator.
#[test]
fn a_signed_zero_normal_is_not_deduped() {
    let router = GeometryRouter::new();
    let (plus, minus) = pair_differing_only_in_normals(
        vec![0.0, -1.0, 0.0, 0.0, -1.0, 0.0, 0.0, -1.0, 0.0],
        vec![-0.0, -1.0, 0.0, -0.0, -1.0, 0.0, -0.0, -1.0, 0.0],
    );
    assert!(
        plus.normals == minus.normals,
        "fixture rot: the pair no longer needs a BITWISE compare to tell apart",
    );
    assert_eq!(
        GeometryRouter::compute_mesh_hash(&plus),
        GeometryRouter::compute_mesh_hash(&minus),
        "fixture rot: the two meshes no longer collide, so this test proves nothing",
    );

    let _ = router.get_or_cache_by_hash(plus);
    let second = router.get_or_cache_by_hash(minus);
    assert!(
        second.normals.iter().step_by(3).all(|v| v.is_sign_negative()),
        "cache served a +0.0 normal for a -0.0 one: {:?}",
        second.normals,
    );
}

/// Identical meshes should still dedupe — the fix must not regress
/// the cache's main job (sharing repeated geometry across N-storey
/// buildings, instanced doors, etc.).
#[test]
fn identical_meshes_still_dedupe() {
    let router = GeometryRouter::new();
    let mut mesh = Mesh::new();
    mesh.positions = vec![0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 2.0, 0.0];
    mesh.indices = vec![0, 1, 2];
    mesh.normals = vec![0.0; 9];

    let first = router.get_or_cache_by_hash(mesh.clone());
    let second = router.get_or_cache_by_hash(mesh.clone());
    assert!(
        Arc::ptr_eq(&first, &second),
        "two identical meshes did not share the cached Arc",
    );
}

/// The instancing rep_identity uses compute_mesh_hash_FULL precisely because
/// the sampled compute_mesh_hash has a blind spot (the #833 family). This forges
/// the blind spot: a 129-vertex mesh and a copy differing only at position index
/// 2 — which the sampled hash (step 3 + last 3) never reads — so the SAMPLED
/// hashes collide while the FULL hash distinguishes them.
#[test]
fn full_hash_sees_what_the_sampled_hash_misses() {
    let n = 387usize; // 129 verts; sampled step = 387/128 = 3 → reads multiples of 3 + last 3
    let mut a = Mesh::new();
    a.positions = (0..n).map(|i| i as f32).collect();
    a.indices = (0..(n / 3) as u32).collect();
    a.normals = vec![0.0; n];
    let mut b = a.clone();
    b.positions[2] = 999.0; // index 2: not a sample point, not in the last 3

    assert_eq!(
        GeometryRouter::compute_mesh_hash(&a),
        GeometryRouter::compute_mesh_hash(&b),
        "sampled hash is intentionally blind to index 2 (this is the gap rep_identity must avoid)",
    );
    assert_ne!(
        GeometryRouter::compute_mesh_hash_full(&a),
        GeometryRouter::compute_mesh_hash_full(&b),
        "FULL hash must distinguish meshes differing outside the sample stride",
    );
}

/// Issue #8287 regression. The instancing `rep_identity` has no equality guard
/// behind it, so the hash is the ONLY place a normals-only difference can be
/// seen — see `compute_mesh_hash_full`'s doc for what the group did with the
/// pair that shared a key. Same genuinely-colliding pair as
/// `normals_only_difference_is_not_deduped`, one layer down.
#[test]
fn the_full_hash_separates_a_normals_only_difference() {
    let (exact, tilted) = normals_only_pair();
    assert_ne!(
        GeometryRouter::compute_mesh_hash_full(&exact),
        GeometryRouter::compute_mesh_hash_full(&tilted),
        "two meshes differing only in their normals share a rep_identity (#8287)",
    );
}

/// Issue #8287, signed-zero half: the hash has to read bit patterns for the
/// same reason `meshes_equal` does. A pair `f32::eq` calls equal still ships
/// different bytes to the consumer, and `-0.0` is what a normalized direction's
/// underflowing component becomes when the numerator is negative.
#[test]
fn the_full_hash_separates_a_signed_zero_normal() {
    let (plus, minus) = pair_differing_only_in_normals(
        vec![0.0, -1.0, 0.0, 0.0, -1.0, 0.0, 0.0, -1.0, 0.0],
        vec![-0.0, -1.0, 0.0, -0.0, -1.0, 0.0, -0.0, -1.0, 0.0],
    );
    assert!(
        plus.normals == minus.normals,
        "fixture rot: the pair no longer needs a BITWISE compare to tell apart",
    );
    assert_ne!(
        GeometryRouter::compute_mesh_hash_full(&plus),
        GeometryRouter::compute_mesh_hash_full(&minus),
        "a -0.0 normal hashes the same as +0.0, so the pair shares a rep_identity (#8287)",
    );
}

/// Positions and normals stream as one concatenated run, so the only thing
/// keeping the buffer boundary in the key is the lengths hashed up front. Two
/// meshes holding the SAME values split differently between the two buffers
/// are different geometry and must hash differently; without the lengths they
/// would feed the hasher identical bytes.
#[test]
fn the_full_hash_sees_the_boundary_between_positions_and_normals() {
    let mut six = Mesh::new();
    six.positions = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
    six.normals = vec![];
    six.indices = vec![0, 1];
    let mut three_three = Mesh::new();
    three_three.positions = vec![1.0, 2.0, 3.0];
    three_three.normals = vec![4.0, 5.0, 6.0];
    three_three.indices = vec![0, 1];

    assert_ne!(
        GeometryRouter::compute_mesh_hash_full(&six),
        GeometryRouter::compute_mesh_hash_full(&three_three),
        "the same values split differently between positions and normals hash alike",
    );
}

/// The fix must not stop identical geometry from sharing a template — that is
/// the whole value of instancing, and a key that separated equal meshes would
/// turn every repeat into its own upload.
#[test]
fn the_full_hash_still_matches_for_identical_meshes() {
    let (one, _) = normals_only_pair();
    let copy = one.clone();
    assert_eq!(
        GeometryRouter::compute_mesh_hash_full(&one),
        GeometryRouter::compute_mesh_hash_full(&copy),
        "two identical meshes no longer share a rep_identity",
    );
}
