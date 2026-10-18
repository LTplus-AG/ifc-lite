// SPDX-License-Identifier: MPL-2.0
//! Platform extraction invariants, evaluated after disposing the IFC decoder.
use super::*;
use crate::processors::advanced_face::{lower_face, take_face_refused};
use nalgebra::Vector3;

fn area(mesh: &Mesh) -> f64 {
    mesh.indices
        .chunks_exact(3)
        .map(|triangle| {
            let p = |i: u32| {
                let k = i as usize * 3;
                Vector3::new(
                    mesh.positions[k] as f64,
                    mesh.positions[k + 1] as f64,
                    mesh.positions[k + 2] as f64,
                )
            };
            (p(triangle[1]) - p(triangle[0]))
                .cross(&(p(triangle[2]) - p(triangle[0])))
                .norm()
                * 0.5
        })
        .sum()
}

fn holed_plane(x: f64, y: f64) -> String {
    let mut source = String::from(
        "#1=IFCADVANCEDBREP(#2);#2=IFCCLOSEDSHELL((#3));\n\
        #3=IFCADVANCEDFACE((#4,#5),#6,.F.);#4=IFCFACEOUTERBOUND(#7,.T.);\n\
        #5=IFCFACEBOUND(#8,.T.);#7=IFCPOLYLOOP((#11,#12,#13,#14));\n\
        #8=IFCPOLYLOOP((#15,#16,#17,#18));#6=IFCPLANE(#9);#9=IFCAXIS2PLACEMENT3D(#11,$,$);\n",
    );
    for (i, (dx, dy)) in [
        (0., 0.),
        (4., 0.),
        (4., 4.),
        (0., 4.),
        (1., 1.),
        (1., 3.),
        (3., 3.),
        (3., 1.),
    ]
    .iter()
    .enumerate()
    {
        source.push_str(&format!(
            "#{}=IFCCARTESIANPOINT(({},{},10.));\n",
            11 + i,
            x + dx,
            y + dy
        ));
    }
    source
}

#[test]
fn holed_advanced_shell_replays_in_f64_rtc_frame_without_filling_the_opening() {
    let plan = {
        let source = holed_plane(2_600_000., 1_200_000.);
        let mut decoder = EntityDecoder::new(&source);
        let entity = decoder.decode_by_id(1).unwrap();
        lower_brep(
            &entity,
            &mut decoder,
            TessellationQuality::Medium,
            Some((2_600_000., 1_200_000., 10.)),
        )
        .unwrap()
    };
    let mesh = plan.clone().evaluate().unwrap();
    assert!(mesh.rtc_applied);
    assert!((area(&mesh) - 12.).abs() < 1e-8);
    assert!(mesh.positions.chunks_exact(3).all(|p| p[2] == 0.));
    for t in mesh.indices.chunks_exact(3) {
        let p = |i: u32| {
            let k = i as usize * 3;
            [mesh.positions[k], mesh.positions[k + 1]]
        };
        let a = p(t[0]);
        let b = p(t[1]);
        let c = p(t[2]);
        assert!(
            (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0.,
            "planar loop winding must not be flipped by SameSense=false"
        );
        let cx = (a[0] + b[0] + c[0]) / 3.;
        let cy = (a[1] + b[1] + c[1]) / 3.;
        assert!(
            !(cx > 1. && cx < 3. && cy > 1. && cy < 3.),
            "triangle centroid occupies the authored opening"
        );
    }
    assert_eq!(mesh.positions, plan.evaluate().unwrap().positions);
}

#[test]
fn advanced_shell_retains_valid_faces_after_unresolved_and_malformed_spline_faces() {
    take_face_refused();
    let plan = {
        let source=holed_plane(0.,0.).replace("((#3))","((#999,#30,#3))")+
            "#30=IFCADVANCEDFACE((),#31,.T.);#31=IFCBSPLINESURFACEWITHKNOTS(1000000,1,((#999)),.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.);";
        let mut decoder = EntityDecoder::new(&source);
        let entity = decoder.decode_by_id(1).unwrap();
        lower_brep(&entity, &mut decoder, TessellationQuality::Medium, None).unwrap()
    };
    assert_eq!(take_face_refused(), [IfcType::IfcAdvancedFace]);
    let mesh = plan.evaluate().unwrap();
    assert!((area(&mesh) - 12.).abs() < 1e-8);
    assert!(
        take_face_refused().is_empty(),
        "source refusals occur once during lowering"
    );
}

fn rational_source(weights: &str) -> String {
    format!("#1=IFCRATIONALBSPLINESURFACEWITHKNOTS(1,1,((#11,#12),(#13,#14)),.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.,{weights});\n\
        #11=IFCCARTESIANPOINT((2600000.,1200000.,10.));\n\
        #12=IFCCARTESIANPOINT((2600000.,1200002.,10.));\n\
        #13=IFCCARTESIANPOINT((2600002.,1200000.,10.));\n\
        #14=IFCCARTESIANPOINT((2600002.,1200002.,14.));")
}
#[test]
fn rational_surface_retains_weights_control_net_and_rebased_midpoint_after_source_disposal() {
    let plan = {
        let source = rational_source("((1.,1.),(1.,3.))");
        let mut decoder = EntityDecoder::new(&source);
        let entity = decoder.decode_by_id(1).unwrap();
        lower_bspline_surface(
            &entity,
            &mut decoder,
            TessellationQuality::Medium,
            Some((2_600_000., 1_200_000., 10.)),
        )
        .unwrap()
    };
    let mesh = plan.evaluate().unwrap();
    assert!(mesh.rtc_applied);
    assert_eq!(mesh.positions.len() / 3, 9 * 7);
    let midpoint = &mesh.positions[(4 * 7 + 3) * 3..(4 * 7 + 3) * 3 + 3];
    for (actual, expected) in midpoint.iter().zip([4. / 3., 4. / 3., 2.]) {
        assert!(
            (*actual as f64 - expected).abs() < 1e-6,
            "rational midpoint {midpoint:?}"
        );
    }
    assert_eq!(mesh.indices.len(), 8 * 6 * 6);
    assert!(
        mesh.normals.is_empty(),
        "preserve the surface processor normal policy"
    );
}
#[test]
fn malformed_rational_grid_is_refused_before_an_owned_surface_is_admitted() {
    for weights in ["((1.,1.),(1.))", "((1.,$),(1.,3.))", "((1.,1.),(1.,0.))"] {
        let source = rational_source(weights);
        let mut decoder = EntityDecoder::new(&source);
        let entity = decoder.decode_by_id(1).unwrap();
        assert!(
            lower_bspline_surface(&entity, &mut decoder, TessellationQuality::Medium, None)
                .is_err()
        );
    }
}

fn analytic_face(surface: &str) -> String {
    format!("#1=IFCADVANCEDFACE((#2),#10,.F.);#2=IFCFACEOUTERBOUND(#3,.T.);\n\
        #3=IFCEDGELOOP((#21,#22,#23,#24));\n\
        #21=IFCORIENTEDEDGE(*,*,#51,.T.);#22=IFCORIENTEDEDGE(*,*,#52,.T.);\n\
        #23=IFCORIENTEDEDGE(*,*,#53,.T.);#24=IFCORIENTEDEDGE(*,*,#54,.T.);\n\
        #51=IFCEDGECURVE(#31,#32,$,.T.);#52=IFCEDGECURVE(#32,#33,$,.T.);\n\
        #53=IFCEDGECURVE(#33,#34,$,.T.);#54=IFCEDGECURVE(#34,#31,$,.T.);\n\
        #31=IFCVERTEXPOINT(#41);#32=IFCVERTEXPOINT(#42);#33=IFCVERTEXPOINT(#43);#34=IFCVERTEXPOINT(#44);\n\
        #41=IFCCARTESIANPOINT((2.,0.,0.));#42=IFCCARTESIANPOINT((0.,2.,0.));\n\
        #43=IFCCARTESIANPOINT((0.,2.,3.));#44=IFCCARTESIANPOINT((2.,0.,3.));\n\
        #11=IFCAXIS2PLACEMENT3D(#12,$,$);#12=IFCCARTESIANPOINT((0.,0.,0.));{surface}")
}
#[test]
fn cylindrical_face_retains_patch_extent_radius_height_and_same_sense_winding() {
    let plan = {
        let source = analytic_face("#10=IFCCYLINDRICALSURFACE(#11,2.);");
        let mut decoder = EntityDecoder::new(&source);
        let face = decoder.decode_by_id(1).unwrap();
        lower_face(&face, &mut decoder, TessellationQuality::Medium, None).unwrap()
    };
    let (positions, indices) = plan.evaluate().unwrap();
    assert!(!indices.is_empty());
    for p in positions.chunks_exact(3) {
        assert!((p[0].hypot(p[1]) - 2.).abs() < 1e-5);
        assert!(p[0] >= -1e-6 && p[1] >= -1e-6);
        assert!(p[2] >= 0. && p[2] <= 3.);
    }
    for t in indices.chunks_exact(3) {
        let p = |i: u32| {
            let k = i as usize * 3;
            Vector3::new(positions[k], positions[k + 1], positions[k + 2])
        };
        let a = p(t[0]);
        let n = (p(t[1]) - a).cross(&(p(t[2]) - a));
        assert!(
            n.x * a.x + n.y * a.y < 0.,
            "false SameSense reverses parameterized winding"
        );
    }
}
#[test]
fn revolution_face_retains_generator_natural_angle_and_axial_extent() {
    let plan = {
        let source=analytic_face("#10=IFCSURFACEOFREVOLUTION(#13,$,#15);\n\
        #15=IFCAXIS1PLACEMENT(#12,$);#13=IFCARBITRARYOPENPROFILEDEF(.CURVE.,$,#16);\n\
        #16=IFCPOLYLINE((#17,#18));#17=IFCCARTESIANPOINT((-2.,0.,0.));#18=IFCCARTESIANPOINT((-2.,0.,3.));");
        let mut decoder = EntityDecoder::new(&source);
        let face = decoder.decode_by_id(1).unwrap();
        lower_face(&face, &mut decoder, TessellationQuality::Medium, None).unwrap()
    };
    let (positions, indices) = plan.evaluate().unwrap();
    assert!(!indices.is_empty());
    for p in positions.chunks_exact(3) {
        assert!((p[0].hypot(p[1]) - 2.).abs() < 1e-5);
        assert!(
            p[0] >= -1e-6 && p[1] >= -1e-6,
            "negative-X generator must sweep into the boundary's first quadrant"
        );
        assert!(p[2] == 0. || p[2] == 3.);
    }
}

#[test]
fn malformed_shell_plain_face_is_skipped_without_poisoning_the_following_face() {
    let plan = {
        let source = holed_plane(0., 0.).replace("((#3))", "((#19,#3))") + "#19=IFCFACE((#4,#5));";
        let mut decoder = EntityDecoder::new(&source);
        let entity = decoder.decode_by_id(1).unwrap();
        lower_brep(&entity, &mut decoder, TessellationQuality::Medium, None).unwrap()
    };
    let mesh = plan.evaluate().unwrap();
    assert!(
        (area(&mesh) - 12.).abs() < 1e-8,
        "the malformed face must remain a recoverable skip before the valid holed face"
    );
}

#[test]
fn malformed_shell_face_with_compatible_attribute_shape_retains_permissive_construction() {
    // Platform extraction preserves the old generic face reader's recovery:
    // it reads attribute shape, rather than asserting the referenced class.
    for spline in [false, true] {
        let plan = {
            let mut source = holed_plane(0., 0.).replace(
                "#3=IFCADVANCEDFACE((#4,#5),#6,.F.);",
                "#3=IFCPROPERTYSINGLEVALUE((#4,#5),#6,.F.,$);",
            );
            if spline {
                source = source.replace("#6=IFCPLANE(#9);",
                    "#6=IFCBSPLINESURFACEWITHKNOTS(1,1,((#11,#12),(#14,#13)),.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.);");
            }
            let mut decoder = EntityDecoder::new(&source);
            let entity = decoder.decode_by_id(1).unwrap();
            lower_brep(&entity, &mut decoder, TessellationQuality::Medium, None).unwrap()
        };
        let mesh = plan.evaluate().unwrap();
        // The unchanged production spline sampler stops 1e-6 inside each
        // knot-domain end. This degree-one patch therefore covers a square
        // with side 4*(1-1e-6), rounded to f32 at vertex emission, rather
        // than the entire 4x4 analytic surface.
        let sampled_side = (4. * (1. - 1e-6)) as f32 as f64;
        let expected_area = if spline { sampled_side * sampled_side } else { 12. };
        let actual_area = area(&mesh);
        assert!((actual_area - expected_area).abs() < 1e-8,
            "spline={spline}: sampled area {actual_area}, expected {expected_area}");
        if spline {
            for triangle in mesh.indices.chunks_exact(3) {
                let p = |index: u32| {
                    let k = index as usize * 3;
                    [mesh.positions[k], mesh.positions[k + 1]]
                };
                let a = p(triangle[0]);
                let b = p(triangle[1]);
                let c = p(triangle[2]);
                assert!(
                    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0.,
                    "the permissive parameterized face still honors false SameSense"
                );
            }
        }
    }
}
