// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! #7468: derive the real BODY cutter cap from authored BREP faces, then observe
//! the shared native producer. This does not assert this preexisting open mesh
//! is universally correct, nor replace the unchanged corpus classifier.
use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::GeometryRouter;
use ifc_lite_processing::{process_geometry, MeshCoordinateSpace};
use std::{collections::HashSet, path::PathBuf, sync::Arc};
#[test]
fn issue_7468_real_92642_preserves_authored_body_cutter_cap() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/models/ara3d/S_Office_Integrated Design Archi.ifc");
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            assert!(std::env::var("IFC_LITE_REQUIRE_FIXTURES").as_deref() != Ok("1"), "pnpm fixtures required: {error}");
            eprintln!("pnpm fixtures: authored S_Office fixture unavailable: {error}"); return;
        }
    };
    let mut decoder = EntityDecoder::with_arc_index(&bytes, Arc::new(build_entity_index(&bytes)));
    let part = decoder.decode_by_id(92642).expect("actual IFC element");
    let shape = decoder.decode_by_id(part.get_ref(6).expect("product shape")).unwrap();
    let representation = decoder.decode_by_id(shape.get_refs(2).unwrap()[0]).unwrap();
    let mut id = representation.get_refs(3).unwrap()[0];
    let mut seen = HashSet::new(); let mut found = false;
    for _ in 0..16 {
        assert!(seen.insert(id), "bounded authored Boolean chain");
        let entity = decoder.decode_by_id(id).unwrap();
        if entity.ifc_type.as_str() != "IFCBOOLEANRESULT" { break; }
        if entity.get_ref(2) == Some(92408) { found = true; break; }
        id = entity.get_ref(1).expect("actual FirstOperand");
    }
    assert!(found, "cutter must actually belong to this BODY chain");
    let brep = decoder.decode_by_id(92408).unwrap();
    let shell = decoder.decode_by_id(brep.get_ref(0).unwrap()).unwrap();
    let faces = shell.get_refs(0).unwrap(); assert!(faces.len() <= 100);
    let mut caps = Vec::new(); let mut work = 0usize;
    for face_id in faces {
        let face = decoder.decode_by_id(face_id).unwrap();
        for bound_id in face.get_refs(0).unwrap() {
            let bound = decoder.decode_by_id(bound_id).unwrap();
            let polygon = decoder.decode_by_id(bound.get_ref(0).unwrap()).unwrap();
            let points = polygon.get_refs(0).unwrap(); assert!(points.len() <= 100);
            let mut zs = Vec::new();
            for point_id in points {
                work += 1; assert!(work <= 1000, "finite authored cap walk");
                let point = decoder.decode_by_id(point_id).unwrap();
                zs.push(point.get_list(0).unwrap()[2].as_float().unwrap());
            }
            if !zs.is_empty() && zs.iter().all(|z| *z == zs[0]) && zs[0] > 0.0 { caps.push(zs[0]); }
        }
    }
    let authored_cap = caps.into_iter().min_by(f64::total_cmp).expect("actual horizontal positive cap");
    let units = GeometryRouter::with_units(&bytes, &mut decoder);
    let placement = units.resolve_scaled_placement(&part, &mut decoder).unwrap();
    assert_eq!([placement[2],placement[6],placement[10],placement[14]], [0.0,0.0,1.0,0.0], "actual source cap stays horizontal, no guessed frame");
    let expected = (authored_cap as f32) * (units.unit_scale() as f32);
    let result = process_geometry(&bytes);
    assert_eq!(result.mesh_coordinate_space, MeshCoordinateSpace::RawIfc);
    let meshes: Vec<_> = result.meshes.iter().filter(|m| m.express_id == 92642).collect();
    assert_eq!(meshes.len(), 1, "real producer target");
    let actual = meshes[0].positions.chunks_exact(3).map(|p| p[2]).min_by(f32::total_cmp).unwrap();
    assert_eq!(actual.to_bits(), expected.to_bits(), "BODY cap from source BREP must survive X-plane promotion; authored={authored_cap}, actual={actual}, expected={expected}");
}
