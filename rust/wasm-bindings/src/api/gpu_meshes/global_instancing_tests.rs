// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

const IDENTITY: [f64; 16] = [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.];

fn template(origin: [f64; 3]) -> Mesh {
    let mut m = Mesh::new();
    m.positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    m.normals = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
    m.indices = vec![0, 1, 2];
    m.origin = origin;
    m
}

fn occurrence(key: u64, entity_id: u32, x: f64, item_id: Option<u32>) -> KeyedOccurrence {
    let mut world = IDENTITY;
    world[3] = x;
    KeyedOccurrence { key, entity_id, color: [0.5, 0.5, 0.5, 1.0], world, item_id, finish: None }
}

/// The key trailer as written: `"IFNL"`, the template count, (hi, lo) per template.
fn trailer(bytes: &[u8]) -> Vec<u64> {
    let words: Vec<u32> = bytes.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    let n = words[2] as usize;
    let at = words.len() - 2 * n - 2;
    assert_eq!(words[at], KEY_TRAILER_MAGIC);
    assert_eq!(words[at + 1] as usize, n);
    words[at + 2..].chunks_exact(2).map(|p| ((p[0] as u64) << 32) | p[1] as u64).collect()
}

/// A keyed shard is an ordinary IFNS shard to a reader that predates the
/// trailer: the existing decoder reads every template and instance and stops
/// at the end of the pools. The trailer names each template's key.
#[test]
fn keyed_shards_decode_as_ifns_and_carry_the_key_trailer() {
    let keys = [(7u64 << 32) | 9, (0x8000_0001u64 << 32) | 4];
    let templates: FxHashMap<u64, Mesh> = [(keys[0], template([1.0, 2.0, 3.0])), (keys[1], template([0.0; 3]))].into_iter().collect();
    let occs = [occurrence(keys[0], 11, 5.0, None), occurrence(keys[0], 13, 1.0, None), occurrence(keys[1], 12, -2.0, Some(40))];
    let bytes = encode_keyed_shard(&keys, &templates, &occs, [0.0; 3]);

    let decoded = ifc_lite_geometry::decode_instanced(&bytes).expect("an old reader decodes a keyed shard");
    assert_eq!(decoded.templates.len(), 2);
    assert_eq!(decoded.templates[0].origin, [1.0, 2.0, 3.0]);
    assert_eq!(decoded.templates[1].indices, vec![0, 1, 2]);
    let ids: Vec<(u32, u32)> = decoded.instances.iter().map(|i| (i.template_index, i.entity_id)).collect();
    assert_eq!(ids, vec![(0, 11), (0, 13), (1, 12)]);
    assert_eq!(decoded.instances[0].transform[3], 5.0, "row-major world translation");
    assert_eq!(decoded.instances[2].item_id, Some(40), "an item id widens the stride for every record");
    assert_eq!(trailer(&bytes), keys.to_vec());
}

/// Instance transforms are post-RTC, as every IFNS reader expects.
#[test]
fn keyed_instances_are_written_in_the_post_rtc_frame() {
    let templates: FxHashMap<u64, Mesh> = [(1 << 32, template([0.0; 3]))].into_iter().collect();
    let occ = [occurrence(1 << 32, 3, 1000.0, None)];
    let bytes = encode_keyed_shard(&[1 << 32], &templates, &occ, [990.0, 0.0, 0.0]);
    let decoded = ifc_lite_geometry::decode_instanced(&bytes).expect("decodes");
    assert_eq!(decoded.instances[0].transform[3], 10.0);
}

/// A batch's first occurrence of a key defines it; later occurrences only
/// reference it. A mesh without a placement cannot be taken to a local frame
/// and is handed back to go flat.
#[test]
fn a_keyed_batch_defines_each_key_once_and_returns_unplaceable_meshes() {
    let mesh = |id: u32, x: f64| {
        let mut m = MeshData::new(id, "IfcFurniture".into(), vec![x as f32, 0.0, 0.0, x as f32 + 1.0, 0.0, 0.0, x as f32, 1.0, 0.0], vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0], vec![0, 1, 2], [1.0; 4]);
        let mut world = IDENTITY;
        world[3] = x;
        m.instance = Some(ifc_lite_geometry::InstanceMeta { transform: world, local_transform: None, canonical_transform: None, rep_identity: 77, instanceable: true });
        m
    };
    let mut batch = KeyedBatch::default();
    assert!(batch.push(5, mesh(1, 10.0), None, [0.0; 3]).is_none());
    assert!(batch.push(5, mesh(2, 20.0), None, [0.0; 3]).is_none());
    let mut bare = mesh(3, 0.0);
    bare.instance = None;
    assert!(batch.push(6, bare, None, [0.0; 3]).is_some(), "no placement: flat");
    assert_eq!(batch.templates.len(), 1);
    assert_eq!(batch.occurrences.len(), 2);
    let local = &batch.templates[&5];
    assert!(local.positions.iter().zip([-0.5f32, -0.5, 0.0]).all(|(a, b)| (a - b).abs() < 1e-6), "{:?}", local.positions);
    assert_eq!(local.origin, [0.5, 0.5, 0.0], "the template origin is its local box centre");

    let bytes = encode_keyed_batch(batch, [0.0; 3]);
    let decoded = ifc_lite_geometry::decode_instanced(&bytes).expect("decodes");
    assert_eq!(decoded.templates.len(), 1);
    assert_eq!(decoded.instances.len(), 2);
    assert_eq!(trailer(&bytes), vec![5]);
}
