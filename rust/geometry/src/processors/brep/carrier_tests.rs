// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::{processors::FacetedBrepProcessor, router::GeometryProcessor, TessellationQuality};
use ifc_lite_core::IfcSchema;

const SOURCE: &str = include_str!("../../../tests/fixtures/issue_7714_soffice_carrier.ifc");

fn run(source: &str) -> (Option<Witness>, Vec<FaceData>, Vec<FaceData>) {
    let mut decoder = EntityDecoder::new(source);
    let item = decoder.decode_by_id(489635).unwrap();
    // Read the authored faces independently of normalization admission so
    // declined topology can still prove the transaction leaves them intact.
    let ids = decoder
        .get_entity_ref_list_fast(item.get(0).unwrap().as_entity_ref().unwrap())
        .unwrap();
    let before: Vec<_> = ids
        .into_iter()
        .map(|id| {
            let bounds = decoder.get_entity_ref_list_fast(id).unwrap();
            let (loop_id, orientation, _) = decoder.get_face_bound_fast(bounds[0]).unwrap();
            let mut points = decoder
                .get_polyloop_coords_cached(loop_id)
                .unwrap()
                .into_iter()
                .map(|(x, y, z)| Point3::new(x, y, z))
                .collect::<Vec<_>>();
            if !orientation {
                points.reverse();
            }
            FaceData {
                outer_points: points,
                hole_points: Vec::new(),
            }
        })
        .collect();
    let mut after: Vec<_> = before
        .iter()
        .map(|f| FaceData {
            outer_points: f.outer_points.clone(),
            hole_points: f.hole_points.clone(),
        })
        .collect();
    (normalize(&item, &mut decoder, &mut after).unwrap(), before, after)
}

fn unchanged(source: &str) {
    let (witness, before, after) = run(source);
    assert!(witness.is_none(), "unexpected repair: {witness:?}");
    for (a, b) in before.iter().zip(after) {
        assert_eq!(a.outer_points, b.outer_points);
    }
}

#[test]
fn issue_7714_real_source_has_unique_adjacent_carrier_and_exact_shared_point_transaction() {
    let (witness, before, after) = run(SOURCE);
    let w = witness.expect("the documented restricted-domain transaction must qualify");
    assert_eq!(w.carriers, [(489621, 489589)]);
    assert_eq!(w.moved.len(), 1);
    assert_eq!(w.moved[0].0, 489593);
    assert_eq!(
        w.moved[0].1,
        Point3::new(95.0001680875, 11845.0000131, -325.)
    );
    assert_eq!(w.moved[0].2, Point3::new(95., 11845.0000131, -325.));
    let mut references = 0;
    for (a, b) in before.iter().zip(&after) {
        for (p, q) in a.outer_points.iter().zip(&b.outer_points) {
            if p == &w.moved[0].1 {
                assert_eq!(q, &w.moved[0].2);
                references += 1;
            } else {
                assert_eq!(p, q, "all other source coordinates must remain exact");
            }
        }
    }
    assert_eq!(
        references, 3,
        "one source point is corrected in all three incident faces"
    );
    // The carrier is sloped: the high-Y points retain X=95.0000003725.
    assert!(after[4].outer_points.iter().any(|p| p.x == 95.0000003725));
}

#[test]
fn issue_7714_missing_precision_excessive_move_and_already_planar_decline_atomically() {
    unchanged(&SOURCE.replace("3,0.01,#80", "3,$,#80"));
    unchanged(&SOURCE.replace("3,0.01,#80", "3,0.00001,#80"));
    unchanged(&SOURCE.replace("95.0001680875", "95.1"));
    unchanged(&SOURCE.replace("95.0001680875", "95."));
    // No third noncollinear source vertex on the existing adjacent carrier.
    unchanged(&SOURCE.replace(
        "95.0000003725,12000.0000131,-325.",
        "95.0001,12000.0000131,-325.",
    ));
    // The source edge identity is not supplied by equal coordinate values.
    let duplicate = SOURCE
        .replace(
            "#489618= IFCPOLYLOOP((#489593,#489578",
            "#489618= IFCPOLYLOOP((#489593,#999999",
        )
        .replace(
            "ENDSEC;END-ISO",
            "#999999=IFCCARTESIANPOINT((95.,11845.0000131,-320.));ENDSEC;END-ISO",
        );
    unchanged(&duplicate);
    // Inward shell and an individual flipped healthy face cannot be repaired.
    unchanged(&SOURCE.replace(".T.)", ".F.)"));
    unchanged(&SOURCE.replace(
        "#489630= IFCFACEOUTERBOUND(#489628,.T.)",
        "#489630= IFCFACEOUTERBOUND(#489628,.F.)",
    ));
}

#[test]
fn issue_7714_public_mesher_normalizes_before_rtc_and_preserves_source() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let item = decoder.decode_by_id(489635).unwrap();
    let processor = FacetedBrepProcessor::new();
    let mesh = processor
        .process(
            &item,
            &mut decoder,
            &IfcSchema::new(),
            TessellationQuality::Medium,
        )
        .unwrap();
    assert!(!mesh
        .positions
        .chunks_exact(3)
        .any(|p| p[0] == 95.0001680875f32));
    assert_eq!(mesh.indices.len() / 3, 16);
    assert_eq!(
        decoder.get_cartesian_point_fast(489593).unwrap().0,
        95.0001680875
    );
    let rtc = processor
        .process_with_rtc(
            &item,
            &mut decoder,
            &IfcSchema::new(),
            (95., 11845.0000131, -325.),
        )
        .unwrap();
    assert!(rtc.rtc_applied);
    assert!(!rtc
        .positions
        .chunks_exact(3)
        .any(|p| p[0] == (95.0001680875 - 95.) as f32));
}

#[test]
fn issue_7714_source_order_cyclic_origins_and_bound_compensated_reversal_are_invariant() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let item = decoder.decode_by_id(489635).unwrap();
    let (shell, ids) = read_shell(&item, &mut decoder).unwrap();
    for rotate in 0..5 {
        for reverse in [false, true] {
            let mut source = SOURCE.to_owned();
            for &face in &ids {
                let bounds = decoder.get_entity_ref_list_fast(face).unwrap();
                let (loop_id, _, _) = decoder.get_face_bound_fast(bounds[0]).unwrap();
                let original = decoder.get_polyloop_point_ids_fast(loop_id).unwrap();
                let mut changed = original.clone();
                let n = changed.len();
                changed.rotate_left(rotate % n);
                if reverse {
                    changed.reverse();
                }
                let list = |ids: &[u32]| {
                    ids.iter()
                        .map(|id| format!("#{id}"))
                        .collect::<Vec<_>>()
                        .join(",")
                };
                source = source.replace(
                    &format!("IFCPOLYLOOP(({}))", list(&original)),
                    &format!("IFCPOLYLOOP(({}))", list(&changed)),
                );
            }
            if reverse {
                source = source.replace(".T.)", ".F.)");
            }
            let list = |ids: &[u32]| {
                ids.iter()
                    .map(|id| format!("#{id}"))
                    .collect::<Vec<_>>()
                    .join(",")
            };
            source = source.replace(
                &format!("IFCCLOSEDSHELL(({}))", list(&ids)),
                &format!(
                    "IFCCLOSEDSHELL(({}))",
                    list(&ids.iter().copied().rev().collect::<Vec<_>>())
                ),
            );
            let (w, _, _) = run(&source);
            assert_eq!(
                w.expect("authored order cannot choose a different carrier")
                    .moved[0]
                    .2,
                Point3::new(95., 11845.0000131, -325.)
            );
        }
    }
    assert_eq!(shell.points.len(), 10);
}

#[test]
fn issue_7714_all_24_proper_signed_axis_rotations_preserve_the_source_correction() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let item = decoder.decode_by_id(489635).unwrap();
    let (shell, _) = read_shell(&item, &mut decoder).unwrap();
    let permutations = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ];
    let mut count = 0;
    for axes in permutations {
        let inversions = (0..3)
            .flat_map(|i| (i + 1..3).map(move |j| (i, j)))
            .filter(|&(i, j)| axes[i] > axes[j])
            .count();
        for signs in [
            [1., 1., 1.],
            [1., 1., -1.],
            [1., -1., 1.],
            [1., -1., -1.],
            [-1., 1., 1.],
            [-1., 1., -1.],
            [-1., -1., 1.],
            [-1., -1., -1.],
        ] {
            if signs.iter().product::<f64>() != if inversions % 2 == 0 { 1. } else { -1. } {
                continue;
            }
            let transform = |p: Point3<f64>| {
                Point3::new(
                    signs[0] * p[axes[0]],
                    signs[1] * p[axes[1]],
                    signs[2] * p[axes[2]],
                )
            };
            let mut source = SOURCE.to_owned();
            for (&id, p) in &shell.points {
                let original = std::str::from_utf8(decoder.get_raw_bytes(id).unwrap()).unwrap();
                let q = transform(exact::rounded(p).unwrap());
                source = source.replace(
                    original,
                    &format!(
                        "#{id}=IFCCARTESIANPOINT(({:.17},{:.17},{:.17}));",
                        q.x, q.y, q.z
                    ),
                );
            }
            let (w, _, _) = run(&source);
            let w = w.expect("proper axis rotation must qualify");
            assert_eq!(
                w.moved[0].2,
                transform(Point3::new(95., 11845.0000131, -325.))
            );
            count += 1;
        }
    }
    assert_eq!(count, 24);
}

#[test]
fn issue_7714_constraints_require_a_unique_consistent_intersection() {
    let p = |x, y, z| exact::point(&Point3::new(x, y, z)).unwrap();
    let x = Plane::through(&[p(0., 0., 0.), p(0., 1., 0.), p(0., 0., 1.)]).unwrap();
    let y = Plane::through(&[p(0., 0., 0.), p(1., 0., 0.), p(0., 0., 1.)]).unwrap();
    let z = Plane::through(&[p(0., 0., 0.), p(1., 0., 0.), p(0., 1., 0.)]).unwrap();
    let other = Plane::through(&[p(1., 0., 0.), p(1., 1., 0.), p(1., 0., 1.)]).unwrap();
    assert!(
        exact::intersection(&[&x, &y]).is_none(),
        "a line is underdetermined"
    );
    assert_eq!(exact::intersection(&[&x, &y, &z]).unwrap(), p(0., 0., 0.));
    assert!(
        exact::intersection(&[&x, &y, &z, &other]).is_none(),
        "all incident planes constrain the point"
    );
}

#[test]
fn issue_7714_original_soffice_operand_retains_complete_context_provenance() {
    let source =
        ifc_lite_testkit::fixture_bytes_or_skip!("ara3d/S_Office_Integrated Design Archi.ifc");
    let source = std::str::from_utf8(&source).expect("original source is UTF-8");
    let (w, _, _) = run(source);
    let w = w.expect("the original source must qualify, not just the isolated scaffold");
    assert_eq!(w.context.contexts, [83, 158, 191]);
    assert_eq!(w.context.length_unit, 31);
    assert_eq!(w.moved[0].2, Point3::new(95., 11845.0000131, -325.));
}

#[test]
fn issue_7714_two_distinct_existing_adjacent_carriers_are_ambiguous() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let item = decoder.decode_by_id(489635).unwrap();
    let (mut shell, _) = read_shell(&item, &mut decoder).unwrap();
    let q = shell.faces[4].clone();
    shell.faces.push(vec![q[2], q[1], q[0]]);
    let rings: Vec<_> = shell.faces.iter().map(|r| ring(&shell, r)).collect();
    let healthy: Vec<_> = rings
        .iter()
        .map(|r| {
            let p = Plane::through(r)?;
            r.iter().all(|v| p.contains(v)).then_some(p)
        })
        .collect();
    assert!(healthy[0].is_some() && healthy[7].is_some());
    assert!(adjacent_carrier(4, &shell, &rings, &healthy).is_none());
}

#[test]
fn issue_7714_finite_carrier_union_rejects_holes_and_double_coverage() {
    let rectangle = |x0, y0, x1, y1| {
        [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
            .iter()
            .map(|&(x, y)| exact::point(&Point3::new(x, y, 0.)).unwrap())
            .collect::<Vec<_>>()
    };
    let full = rectangle(0., 0., 4., 4.);
    let plane = Plane::through(&full).unwrap();
    let coverage = |rings: Vec<Vec<P>>| {
        let planes = vec![plane.clone(); rings.len()];
        super::super::carrier_validate::finite_coverage(&rings, &planes)
    };
    assert!(coverage(vec![rectangle(0., 0., 2., 4.), rectangle(2., 0., 4., 4.)]).is_some());
    assert!(coverage(vec![full.clone(), full]).is_none(), "double cover");
    assert!(
        coverage(vec![
            rectangle(0., 0., 4., 1.),
            rectangle(0., 3., 4., 4.),
            rectangle(0., 1., 1., 3.),
            rectangle(3., 1., 4., 3.)
        ])
        .is_none(),
        "coplanar hole"
    );
}

#[test]
fn issue_7714_a_closed_positive_volume_nonconvex_shell_declines() {
    // Unit-height L prism: a valid closed positive-volume shell, with an
    // inward corner. It is outside the convex normalization contract.
    let polygon=[(0.,0.),(2.,0.),(2.,1.),(1.,1.),(1.,2.),(0.,2.)];
    let mut shell=Shell {points:BTreeMap::new(),faces:Vec::new()};
    for (i,&(x,y)) in polygon.iter().enumerate() {
        for z in 0..2 {shell.points.insert((i+6*z) as u32,exact::point(&Point3::new(x,y,z as f64)).unwrap());}
    }
    shell.faces.push((0..6).rev().collect());
    shell.faces.push((6..12).collect());
    for i in 0..6 {let j=(i+1)%6;shell.faces.push(vec![i,j,j+6,i+6]);}
    let rings:Vec<_>=shell.faces.iter().map(|r|ring(&shell,r)).collect();
    let planes:Vec<_>=rings.iter().map(|r|Plane::through(r).unwrap()).collect();
    let volume6:R=rings.iter().map(|r|(1..r.len()-1).map(|i|
        exact::dot(&r[0],&exact::cross(&r[i],&r[i+1]))).sum::<R>()).sum();
    assert_eq!(volume6,R::from_float(18.).unwrap());
    assert!(super::super::carrier_validate::validate(&shell,&rings,&planes).is_none());
}
