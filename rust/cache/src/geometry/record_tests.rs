// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

pub(crate) fn sample(express_id: u32, origin: [f64; 3]) -> CacheMesh {
    CacheMesh {
        express_id,
        ifc_type: "IfcWall".to_owned(),
        positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        normals: vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
        indices: vec![0, 1, 2],
        color: [1.0, 0.5, 0.25, 1.0],
        geometry_class: 0,
        geometry_item_id: None,
        material_id: Some(0),
        origin,
        metallic: None,
        roughness: Some(0.0),
        shading_color: None,
        local_bounds: None,
        local_to_world: None,
    }
}

fn written(mesh: &CacheMesh) -> Vec<u8> {
    let mut buf = Buf::new();
    mesh.write(&mut buf);
    buf.into_vec()
}

#[test]
fn record_len_matches_the_bytes_with_and_without_every_trailer() {
    let mut mesh = sample(1, [0.0; 3]);
    assert_eq!(written(&mesh).len(), mesh.record_len());
    mesh.shading_color = Some([0.1, 0.2, 0.3, 1.0]);
    mesh.local_bounds = Some([0.0, 0.0, 0.0, 1.0, 1.0, 1.0]);
    mesh.local_to_world = Some([1.0; 16]);
    assert_eq!(written(&mesh).len(), mesh.record_len());
}

#[test]
fn absent_ids_are_the_sentinel_and_a_zero_material_survives() {
    // #3199: 0 is a real material-layer id; only 0xFFFFFFFF means absent.
    let bytes = written(&sample(42, [0.0; 3]));
    let at = 4 + 8 + 16 + 4 + "IfcWall".len() + 1;
    let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
    assert_eq!(word(at), u32::MAX);
    assert_eq!(word(at + 4), 0);
}

#[test]
fn absent_finish_is_nan_and_a_zero_finish_is_kept() {
    let bytes = written(&sample(1, [0.0; 3]));
    let finish_at = bytes.len() - 1 - 8;
    let metallic = f32::from_le_bytes(bytes[finish_at..finish_at + 4].try_into().unwrap());
    let roughness = f32::from_le_bytes(bytes[finish_at + 4..finish_at + 8].try_into().unwrap());
    assert_eq!(metallic.to_bits(), f32::NAN.to_bits());
    assert_eq!(roughness, 0.0);
    assert_eq!(bytes[finish_at - 1], 0, "provenance mode 0 precedes the finish");
    assert_eq!(*bytes.last().unwrap(), 0, "no metadata flags");
}

#[test]
fn anchor_is_origin_plus_first_vertex() {
    let mut mesh = sample(1, [10.0, 20.0, 30.0]);
    mesh.positions[0] = 0.5;
    assert_eq!(mesh.anchor(), [10.5, 20.0, 30.0]);
    mesh.positions.clear();
    assert_eq!(mesh.anchor(), [10.0, 20.0, 30.0]);
}
