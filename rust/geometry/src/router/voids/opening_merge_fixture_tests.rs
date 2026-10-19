// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #6940: approximate rectangular merging filled an authored step in NUS
//! wall143268. This admitted IfcOpenShell0.8.5 face point lies outside every
//! authored opening. It exceeded the100um surface gate during depth-slice
//! qualification; an exact rectangular union must preserve the wall here.
use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use crate::{GeometryRouter, MaterialLayerIndex, Vector3};
use rustc_hash::FxHashMap;
use std::sync::Arc;

type Point = Vector3<f64>;

fn finite_distance_squared(p: Point, t: [Point; 3]) -> f64 {
    let n = (t[1] - t[0]).cross(&(t[2] - t[0]));
    let nn = n.norm_squared();
    assert!(nn > 0.0, "the original emitted indexed face must be noncollapsed");
    let h = (p - t[0]).dot(&n);
    let foot = p - n * (h / nn);
    let mut distance = f64::INFINITY;
    if (0..3).all(|i| (t[(i + 1) % 3] - t[i]).cross(&(foot - t[i])).dot(&n) >= 0.0) {
        distance = h * h / nn;
    }
    for i in 0..3 {
        let a = t[i];
        let e = t[(i + 1) % 3] - a;
        let u = ((p - a).dot(&e) / e.norm_squared()).clamp(0.0, 1.0);
        distance = distance.min((p - a - e * u).norm_squared());
    }
    distance
}

#[test]
fn issue_6940_rectangular_merge_keeps_the_authored_nus_wall_step() {
    let Some(bytes) = ifc_lite_testkit::fixture_bytes("ara3d/ISSUE_068_ARK_NUS_skolebygg.ifc") else { return };
    let index = Arc::new(build_entity_index(&bytes));
    let mut decoder = EntityDecoder::with_arc_index(&bytes, index);
    let scale = GeometryRouter::with_units(&bytes, &mut decoder).unit_scale();
    let mut router = GeometryRouter::with_scale_and_local_frame(scale, true);
    router.set_material_layer_index(Arc::new(MaterialLayerIndex::from_content(&bytes, &mut decoder)));
    let mut ids = Vec::new();
    let mut scanner = EntityScanner::new(&bytes);
    while let Some((id, name, start, end)) = scanner.next_entity() {
        if name == "IFCRELVOIDSELEMENT" {
            let rel = decoder.decode_at_with_id(id, start, end).unwrap();
            if rel.get_ref(4) == Some(143268) { ids.push(rel.get_ref(5).unwrap()); }
        }
    }
    assert_eq!(ids, vec![143286,143314,143341,1645482,1645517,1645554,1645591]);
    let voids: FxHashMap<u32, Vec<u32>> = [(143268, ids)].into_iter().collect();
    let entity = decoder.decode_by_id(143268).unwrap();
    let _budget = crate::kernel::budget::enter_element();
    let collection = router.process_element_with_submeshes_and_voids(&entity, &mut decoder, &voids).unwrap();
    assert_eq!(collection.sub_meshes.len(), 8, "every original material layer must survive");
    let p = Point::new(153.13055925581688, 200.12144103865563, 142.27990283416614);
    let mut minimum = f64::INFINITY;
    for sub in collection.sub_meshes {
        let m = sub.mesh;
        for ix in m.indices.chunks_exact(3) {
            let triangle = std::array::from_fn(|k| {
                let i = ix[k] as usize * 3;
                Point::new(f64::from(m.positions[i]) + m.origin[0],
                    f64::from(m.positions[i + 1]) + m.origin[1],
                    f64::from(m.positions[i + 2]) + m.origin[2])
            });
            minimum = minimum.min(finite_distance_squared(p, triangle));
        }
    }
    assert!(minimum.sqrt() <= 0.0001,
        "rectangular merging removed an authored wall step beyond100um: {}um", minimum.sqrt() * 1e6);
}
