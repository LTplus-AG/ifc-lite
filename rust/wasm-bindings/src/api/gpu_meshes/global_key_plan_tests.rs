// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

fn tri(indices: Vec<u32>) -> ifc_lite_processing::MeshData {
    ifc_lite_processing::MeshData::new(1, "IfcWall".into(), vec![11.0, 2.0, 3.0, 12.0, 2.0, 3.0, 11.0, 3.0, 3.0], vec![1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0], indices, [1.0; 4])
}

/// Voided hosts never count; a key needs `gate` members; plan indices follow
/// each key's smallest member id, so job order cannot change them.
#[test]
fn plan_counts_unvoided_members_and_orders_by_first_member() {
    let ids = [5, 3, 9, 4, 7, 8];
    let k = |v: u128| Some(v);
    let keys = [k(1), k(1), k(2), k(1), None, k(2)];
    let voided: FxHashSet<u32> = [4].into_iter().collect();
    let plan = build_key_plan(&ids, &keys, &voided, 2);
    assert_eq!(plan.keys, 2);
    assert_eq!(plan.job_plan, vec![0, 0, 1, KEY_PLAN_NONE, KEY_PLAN_NONE, 1]);

    let reversed: Vec<u32> = ids.iter().rev().copied().collect();
    let rkeys: Vec<Option<u128>> = keys.iter().rev().copied().collect();
    let rplan = build_key_plan(&reversed, &rkeys, &voided, 2);
    assert_eq!(rplan.job_plan, plan.job_plan.iter().rev().copied().collect::<Vec<_>>());
    assert_eq!(build_key_plan(&ids, &keys, &voided, 3).keys, 0, "two unvoided members miss a gate of three");
}

/// Two meshes of one plan entry with different topology (a winding flipped
/// by orientation) never share a template key; equal topology always does.
#[test]
fn template_keys_separate_topology_variants_of_one_plan_entry() {
    let a = tri(vec![0, 1, 2]);
    let flipped = tri(vec![0, 2, 1]);
    assert_eq!(template_key(42, 42, 0, &a), template_key(42, 42, 0, &tri(vec![0, 1, 2])));
    assert_ne!(template_key(42, 42, 0, &a), template_key(42, 42, 0, &flipped));
    assert_ne!(template_key(42, 42, 0, &a), template_key(42, 42, 1, &a), "sub-mesh index");
    assert_eq!(template_key(42, 42, 0, &a) >> 32, 42);
    assert_eq!(template_key(content_key_hi(3), 9, 0, &a) >> 32, (KEY_PLAN_TAG | 3) as u64);
    assert!(is_mapped_key_id(1) && !is_mapped_key_id(0) && !is_mapped_key_id(KEY_PLAN_TAG));
}

/// `to_local` inverts the placement: the local template placed by the same
/// matrix lands back on the input positions.
#[test]
fn to_local_inverts_the_placement() {
    let mut m = tri(vec![0, 1, 2]);
    m.origin = [100.0, 0.0, 0.0];
    // W: rotate 90° about z, translate (10, 0, 0).
    let w = [0.0, -1.0, 0.0, 10.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    let l = to_local(&m, &w, [0.0; 3]).expect("invertible");
    for (v, p) in l.positions.chunks_exact(3).zip(m.positions.chunks_exact(3)) {
        let q: [f64; 3] = std::array::from_fn(|k| l.origin[k] + v[k] as f64);
        let placed = [w[0] * q[0] + w[1] * q[1] + w[2] * q[2] + w[3], w[4] * q[0] + w[5] * q[1] + w[6] * q[2] + w[7], q[2]];
        for k in 0..3 {
            assert!((placed[k] - (m.origin[k] + p[k] as f64)).abs() < 1e-5, "{placed:?} vs {p:?}");
        }
    }
    assert!((l.normals[1] + 1.0).abs() < 1e-6, "normals follow Wᵀ: {:?}", l.normals);
    let singular = [0.0; 16];
    assert!(to_local(&m, &singular, [0.0; 3]).is_none());
}
