// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5984: IFNS trailing field 2, the per-occurrence finish.

use super::*;
use crate::instancing::{encode_refs, encode_refs_with_finishes, Collated, InstanceMeshRef};

const POS: [f32; 9] = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
const NRM: [f32; 9] = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
const IDX: [u32; 3] = [0, 1, 2];

fn refs(item_ids: [Option<u32>; 3]) -> Vec<InstanceMeshRef<'static>> {
    item_ids
        .iter()
        .enumerate()
        .map(|(i, &item_id)| InstanceMeshRef {
            positions: &POS,
            normals: &NRM,
            indices: &IDX,
            origin: [i as f64, 0.0, 0.0],
            instance_meta: None,
            entity_id: 10 + i as u32,
            color: [0.5, 0.5, 0.5, 1.0],
            item_id,
        })
        .collect()
}

/// Every mesh a flat singleton template: the encoder writes them all.
fn all_flat() -> Collated {
    Collated { flat_indices: vec![0, 1, 2], ..Collated::default() }
}

#[test]
fn a_shard_without_finishes_is_byte_identical_to_encode_refs() {
    for ids in [[None; 3], [Some(7), None, Some(9)]] {
        let r = refs(ids);
        let plain = encode_refs(&r, &all_flat());
        assert_eq!(encode_refs_with_finishes(&r, &all_flat(), &[[f32::NAN; 2]; 3]), plain);
        assert_eq!(encode_refs_with_finishes(&r, &all_flat(), &[]), plain);
        let finishes = decode_instance_finishes(&plain).expect("decodes");
        assert!(finishes.iter().flatten().all(|v| v.is_nan()), "no field, so all unauthored");
    }
}

#[test]
fn finishes_ride_field_two_and_every_older_field_still_decodes() {
    let r = refs([None, Some(42), None]);
    // Occurrence 0 authors a roughness of exactly 0 (glass), 1 a metal, 2 nothing.
    let shard = encode_refs_with_finishes(&r, &all_flat(), &[[f32::NAN, 0.0], [1.0, f32::NAN]]);
    let word = |o: usize| u32::from_le_bytes(shard[o..o + 4].try_into().unwrap());
    assert_eq!(word(4), 3, "version 3");
    assert_eq!(word(28), 100, "stride 100: base + item id + finish");

    let decoded = decode_instanced(&shard).expect("an existing decoder reads v3");
    let ids: Vec<Option<u32>> = decoded.instances.iter().map(|i| i.item_id).collect();
    assert_eq!(ids, vec![None, Some(42), None], "field 1 is written, 0-filled, beside field 2");
    assert_eq!(decoded.instances[1].entity_id, 11);

    let f = decode_instance_finishes(&shard).expect("decodes");
    assert!(f[0][0].is_nan() && f[0][1] == 0.0, "an authored 0 is kept: {:?}", f[0]);
    assert!(f[1][0] == 1.0 && f[1][1].is_nan(), "{:?}", f[1]);
    assert!(f[2].iter().all(|v| v.is_nan()), "{:?}", f[2]);
}

#[test]
fn a_truncated_instance_table_is_refused() {
    let shard = encode_refs_with_finishes(&refs([None; 3]), &all_flat(), &[[0.5, 0.5]; 3]);
    let data_start = 32 + 3 * 48 + 3 * 100;
    assert!(decode_instance_finishes(&shard[..data_start - 1]).is_none());
}
