// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Temporary #7955 M4 round-2 authority diagnostic; no retained implementation.
use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{material_layer_index::MaterialLayerIndex, GeometryRouter, Mesh, SubMeshCollection};
use rustc_hash::FxHashMap;

const CURVED: &str = include_str!("../../../tests/fixtures/synthetic-retained/f-a-curved.ifc");

fn exact_layers(content: &str, id: u32, opening: Option<u32>) -> SubMeshCollection {
    let mut decoder = EntityDecoder::new(content);
    let router = GeometryRouter::with_units(content, &mut decoder);
    let index = MaterialLayerIndex::from_content(content, &mut decoder);
    let element = decoder.decode_by_id(id).expect("fixture product");
    let mut voids = FxHashMap::default();
    if let Some(opening) = opening { voids.insert(id, vec![opening]); }
    router.process_element_with_material_layers(&element, &mut decoder,
        index.get(id).expect("authored material usage"), &voids)
        .expect("real exact layer program").expect("admitted layer program")
}

fn points(mesh: &Mesh) -> impl Iterator<Item = [f64; 3]> + '_ {
    mesh.indices.iter().map(|&index| std::array::from_fn(|axis|
        f64::from(mesh.positions[index as usize * 3 + axis]) + mesh.origin[axis]))
}

fn range(mesh: &Mesh, coordinate: impl Fn([f64; 3]) -> f64) -> [f64; 2] {
    points(mesh).map(coordinate).fold([f64::INFINITY, f64::NEG_INFINITY],
        |[lo, hi], v| [lo.min(v), hi.max(v)])
}

#[test]
fn m4_round2_exact_f_a_ordering_diagnostic() {
    // #23: AXIS2, NEGATIVE, offset=0; C={.1,.3}. Exact uses n=-Y,
    // d=offset+sense*C={-.1,-.3}. Its first flipped-plane clip retains
    // y>-.1, middle -.3<y<-.1, last y<-.3, independent of radial distance.
    let output = exact_layers(CURVED, 55, Some(63));
    assert_eq!(output.sub_meshes.iter().map(|m| m.geometry_id).collect::<Vec<_>>(), [16, 18, 20]);
    let mut radial = Vec::new();
    for sub in &output.sub_meshes {
        let y = range(&sub.mesh, |p| p[1]);
        let rho = range(&sub.mesh, |p| p[0].hypot(p[1]));
        println!("EXACT material={} y={y:?} rho={rho:?}", sub.geometry_id);
        radial.push(rho);
    }
    // Interior witness well above the opening: all radii at theta=+pi/8
    // have y>-.1. In particular rho=10.45 belongs to authored band 2,
    // but exact assigns that part of the upper shell to material16/band0.
    assert!(radial[0][1] > 10.5, "exact first band reaches beyond authored first band's 10.1 radius");
    assert!(range(&output.sub_meshes[0].mesh, |p| p[1])[0] > -0.101);
    assert!(range(&output.sub_meshes[1].mesh, |p| p[1])[1] < -0.099);
    assert!(range(&output.sub_meshes[2].mesh, |p| p[1])[1] < -0.299);

    let mut decoder = EntityDecoder::new(CURVED);
    let router = GeometryRouter::with_units(CURVED, &mut decoder);
    for (id, opening, shift_y, lo, hi) in [
        (122, 129, 30., 10., 10.1), (188, 195, 40., 10.1, 10.3), (254, 261, 50., 10.3, 10.6),
    ] {
        let entity = decoder.decode_by_id(id).unwrap();
        let voids = FxHashMap::from_iter([(id, vec![opening])]);
        let mesh = router.process_element_with_voids(&entity, &mut decoder, &voids).unwrap();
        let rho = range(&mesh, |p| p[0].hypot(p[1] - shift_y));
        println!("AUTHORED proxy={id} rho={rho:?} source_interval=[{lo},{hi}]");
        // Existing curved chord/weld budget (m4.json), not a widened tolerance.
        assert!(rho[0] >= lo - 1e-3 && rho[1] <= hi + 1e-3);
    }
}

#[test]
fn m4_round2_exact_ignores_arc_orientation_for_both_usage_senses() {
    for (sense, usage) in [(-1., ".NEGATIVE."), (1., ".POSITIVE.")] {
        let ccw = CURVED.replace("#23=IFCMATERIALLAYERSETUSAGE(#22,.AXIS2.,.NEGATIVE.,0.,$);",
            &format!("#23=IFCMATERIALLAYERSETUSAGE(#22,.AXIS2.,{usage},0.,$);"));
        // Reverse only the Axis traversal over the same quarter circle.
        // Trim1/Trim2 swap AND SenseAgreement reverses; the body stays fixed.
        let cw = ccw.replace(
            "#28=IFCTRIMMEDCURVE(#27,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(1.5707963267949)),.T.,.PARAMETER.);",
            "#28=IFCTRIMMEDCURVE(#27,(IFCPARAMETERVALUE(1.5707963267949)),(IFCPARAMETERVALUE(0.)),.F.,.PARAMETER.);");
        assert_ne!(ccw, cw);
        let a = exact_layers(&ccw, 55, Some(63));
        let b = exact_layers(&cw, 55, Some(63));
        assert_eq!(a.sub_meshes.len(), b.sub_meshes.len());
        for (a, b) in a.sub_meshes.iter().zip(&b.sub_meshes) {
            assert_eq!(a.geometry_id, b.geometry_id);
            assert_eq!(a.mesh.positions, b.mesh.positions);
            assert_eq!(a.mesh.indices, b.mesh.indices);
            assert_eq!(a.mesh.origin, b.mesh.origin);
        }
        println!("EXACT sigma=+1 vs sigma=-1 sense={sense}: identical positions/indices/origins/material order");
    }
}

#[test]
fn m4_round2_exact_straight_positive_negative_arithmetic() {
    let fixture = include_str!("../../../tests/fixtures/cli-retained/layered-wall.ifc")
        .replace("#24=IFCLOCALPLACEMENT($,#23);", "#24=IFCLOCALPLACEMENT($,#2);");
    for (usage, offset, expected) in [(".POSITIVE.", "0.", [0., 0.1]), (".NEGATIVE.", "1.", [0.9, 1.])] {
        let content = fixture.replace("#83=IFCMATERIALLAYERSETUSAGE(#82,.AXIS2.,.POSITIVE.,0.);",
            &format!("#83=IFCMATERIALLAYERSETUSAGE(#82,.AXIS2.,{usage},{offset});"));
        let output = exact_layers(&content, 27, None);
        assert_eq!(output.sub_meshes.len(), 2);
        let first_y = range(&output.sub_meshes[0].mesh, |p| p[1]);
        // POSITIVE: d=0+1*.1=.1, first y<.1 => [0,.1].
        // NEGATIVE: d=1-1*.1=.9, first y>.9 => [.9,1].
        for (actual, hand) in first_y.into_iter().zip(expected) {
            assert!((actual - hand).abs() <= 1e-6);
        }
        println!("EXACT straight {usage} offset={offset} first_y={first_y:?}, hand={expected:?}");
    }
}
