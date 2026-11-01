// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::processors::SurfaceCurveSweptAreaSolidProcessor;
use crate::TessellationQuality;
use ifc_lite_core::{EntityDecoder, IfcSchema};

fn lower(kind: &str) -> SurfaceCurveSweepPlan {
    let source = format!(
        "#1=IFCCARTESIANPOINT((0.,0.,0.));\n\
        #2=IFCCARTESIANPOINT((0.,0.,3.));\n\
        #3=IFCPOLYLINE((#1,#2));\n\
        #4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);\n\
        #5=IFCCARTESIANPOINT((10.,20.,30.));\n\
        #6=IFCAXIS2PLACEMENT3D(#5,$,$);\n\
        #7={kind}(#4,#6,#3,$,$,$);"
    );
    let mut decoder = EntityDecoder::new(&source);
    let entity = decoder.decode_by_id(7).unwrap();
    SurfaceCurveSweptAreaSolidProcessor::new(IfcSchema::new())
        .lower(&entity, &mut decoder, TessellationQuality::Medium)
        .unwrap()
        .unwrap()
}

#[test]
fn owned_swept_area_retains_profile_and_placed_raw_directrix_after_source_disposal() {
    for kind in [
        "IFCSURFACECURVESWEPTAREASOLID",
        "IFCFIXEDREFERENCESWEPTAREASOLID",
    ] {
        let mesh = lower(kind).evaluate().unwrap();
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for vertex in mesh.positions.chunks_exact(3) {
            for axis in 0..3 {
                min[axis] = min[axis].min(vertex[axis]);
                max[axis] = max[axis].max(vertex[axis]);
            }
        }
        assert_eq!(min, [8.0, 19.0, 30.0]);
        assert_eq!(max, [12.0, 21.0, 33.0]);
        // Independent divergence-theorem volume for the authored rectangular prism.
        let volume: f64 = mesh
            .indices
            .chunks_exact(3)
            .map(|tri| {
                let p = |id: u32| {
                    nalgebra::Vector3::new(
                        mesh.positions[id as usize * 3] as f64,
                        mesh.positions[id as usize * 3 + 1] as f64,
                        mesh.positions[id as usize * 3 + 2] as f64,
                    )
                };
                p(tri[0]).dot(&p(tri[1]).cross(&p(tri[2]))) / 6.0
            })
            .sum();
        assert!((volume.abs() - 24.0).abs() < 1e-8);
        assert_eq!(mesh.positions.len(), mesh.normals.len());
        assert!(mesh.normals.iter().all(|n| n.is_finite()));
    }
}

#[test]
fn owned_swept_area_preserves_missing_profile_refusal() {
    let mut decoder = EntityDecoder::new("#1=IFCSURFACECURVESWEPTAREASOLID($,$,#98,$,$,$);");
    let entity = decoder.decode_by_id(1).unwrap();
    let error = SurfaceCurveSweptAreaSolidProcessor::new(IfcSchema::new())
        .lower(&entity, &mut decoder, TessellationQuality::Medium)
        .unwrap_err();
    assert!(error.to_string().contains("SweptArea"));
}

#[test]
fn composite_sweep_over_the_vertex_budget_is_refused_with_the_exact_count() {
    let square = |x: f64| {
        Profile2D::new(vec![
            nalgebra::Point2::new(x, 0.0),
            nalgebra::Point2::new(x + 1.0, 0.0),
            nalgebra::Point2::new(x + 1.0, 1.0),
            nalgebra::Point2::new(x, 1.0),
        ])
    };
    // 2 regions x 4 ring points x 16385 stations = 131080 > 1 << 17.
    let plan = SurfaceCurveSweepPlan {
        regions: vec![square(0.0), square(3.0)],
        points: (0..16385)
            .map(|i| Point3::new(0.0, 0.0, i as f64 * 0.001))
            .collect(),
        entity_id: 77,
        roll: None,
    };
    let error = plan.evaluate().unwrap_err();
    assert_eq!(
        error.to_string(),
        "Geometry processing error: Sweep would place 131080 ring vertices, over 131072, at #77"
    );
}

/// Bounds of the mesh of `#10` in `source`.
fn bounds_of(source: &str) -> ([f32; 3], [f32; 3]) {
    let mut decoder = EntityDecoder::new(source);
    let entity = decoder.decode_by_id(10).unwrap();
    let mesh = SurfaceCurveSweptAreaSolidProcessor::new(IfcSchema::new())
        .lower(&entity, &mut decoder, TessellationQuality::Medium)
        .unwrap()
        .unwrap()
        .evaluate()
        .unwrap();
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for vertex in mesh.positions.chunks_exact(3) {
        for axis in 0..3 {
            min[axis] = min[axis].min(vertex[axis]);
            max[axis] = max[axis].max(vertex[axis]);
        }
    }
    assert!(mesh.normals.iter().all(|n| n.is_finite()));
    (min, max)
}

fn assert_close(actual: [f32; 3], expected: [f32; 3]) {
    for axis in 0..3 {
        assert!((actual[axis] - expected[axis]).abs() < 1e-5, "{actual:?} != {expected:?}");
    }
}

/// A 0.2 x 1.0 section along +Y. With the rotation-minimising frame its X span
/// (0.2) stood vertical; ISO 10303-42 puts Axis1 on the reference: the
/// IfcSurfaceOfLinearExtrusion normal t x Z = +X, so the 0.2 span lies along
/// X and the 1.0 span stands along Z (Axis2 = t x Axis1 = -Z). This is the
/// Revit slab-edge / sconce case reduced to a straight directrix.
#[test]
fn linear_extrusion_reference_surface_fixes_the_section_roll() {
    let source = "#1=IFCCARTESIANPOINT((0.,0.,0.));\n\
        #2=IFCCARTESIANPOINT((0.,5.,0.));\n\
        #3=IFCPOLYLINE((#1,#2));\n\
        #4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,0.2,1.);\n\
        #5=IFCCARTESIANPOINT((0.,0.));\n\
        #6=IFCCARTESIANPOINT((0.,5.));\n\
        #7=IFCPOLYLINE((#5,#6));\n\
        #8=IFCARBITRARYOPENPROFILEDEF(.CURVE.,$,#7);\n\
        #9=IFCDIRECTION((0.,0.,1.));\n\
        #11=IFCSURFACEOFLINEAREXTRUSION(#8,$,#9,1.);\n\
        #10=IFCSURFACECURVESWEPTAREASOLID(#4,$,#3,$,$,#11);";
    let (min, max) = bounds_of(source);
    assert_close(min, [-0.1, 0.0, -0.5]);
    assert_close(max, [0.1, 5.0, 0.5]);
}

/// The same section with an IfcPlane (normal +Z) as reference surface: Axis1
/// is +Z, so the 0.2 span stands along Z and the 1.0 span lies along X.
#[test]
fn plane_reference_surface_fixes_the_section_roll() {
    let source = "#1=IFCCARTESIANPOINT((0.,0.,0.));\n\
        #2=IFCCARTESIANPOINT((0.,5.,0.));\n\
        #3=IFCPOLYLINE((#1,#2));\n\
        #4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,0.2,1.);\n\
        #5=IFCAXIS2PLACEMENT3D(#1,$,$);\n\
        #11=IFCPLANE(#5);\n\
        #10=IFCSURFACECURVESWEPTAREASOLID(#4,$,#3,$,$,#11);";
    let (min, max) = bounds_of(source);
    assert_close(min, [-0.5, 0.0, -0.1]);
    assert_close(max, [0.5, 5.0, 0.1]);
}

/// IfcFixedReferenceSweptAreaSolid: Axis1 is the FixedReference (+Z here)
/// projected onto the plane normal to the tangent.
#[test]
fn fixed_reference_fixes_the_section_roll() {
    let source = "#1=IFCCARTESIANPOINT((0.,0.,0.));\n\
        #2=IFCCARTESIANPOINT((0.,5.,0.));\n\
        #3=IFCPOLYLINE((#1,#2));\n\
        #4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,0.2,1.);\n\
        #11=IFCDIRECTION((0.,0.,1.));\n\
        #10=IFCFIXEDREFERENCESWEPTAREASOLID(#4,$,#3,$,$,#11);";
    let (min, max) = bounds_of(source);
    assert_close(min, [-0.5, 0.0, -0.1]);
    assert_close(max, [0.5, 5.0, 0.1]);
}

/// `IfcSurfaceOfLinearExtrusion` normal = C'(u) x D: its sign follows the
/// SweptCurve, whichever way the directrix runs (#8437).
#[test]
fn extrusion_normal_follows_the_swept_curve_not_the_directrix() {
    let forward = [Point3::new(0.0, 0.0, 0.0), Point3::new(10.0, 0.0, 0.0)];
    let reversed = [forward[1], forward[0]];
    let up = Vector3::new(0.0, 0.0, 1.0);
    // Directrix samples at another height on the surface, in both orders.
    let along = [Point3::new(2.0, 0.0, 3.0), Point3::new(8.0, 0.0, 3.0)];
    let against = [along[1], along[0]];
    for points in [&along, &against] {
        let normals = extrusion_normals(&forward, &up, points).unwrap();
        assert!(normals.iter().all(|n| (n - Vector3::new(0.0, -1.0, 0.0)).norm() < 1e-12), "{normals:?}");
        let normals = extrusion_normals(&reversed, &up, points).unwrap();
        assert!(normals.iter().all(|n| (n - Vector3::new(0.0, 1.0, 0.0)).norm() < 1e-12), "{normals:?}");
    }
    // A SweptCurve running along D has no normal.
    let vertical = [Point3::new(0.0, 0.0, 0.0), Point3::new(0.0, 0.0, 5.0)];
    assert!(extrusion_normals(&vertical, &up, &along).is_none());
}

/// A reference parallel to the tangent at even one sample gives no Axis1
/// there. The whole sweep then keeps the RMF, so the section never switches
/// frame mid-sweep and twists (#8437).
#[test]
fn a_reference_parallel_to_the_tangent_anywhere_keeps_the_rmf_for_the_whole_sweep() {
    // Off-centre, so a frame rotated by any angle moves the section.
    let rectangle = Profile2D::new(vec![
        nalgebra::Point2::new(0.0, -1.0),
        nalgebra::Point2::new(0.2, -1.0),
        nalgebra::Point2::new(0.2, 0.0),
        nalgebra::Point2::new(0.0, 0.0),
    ]);
    // Along +Y, then up +Z: the last tangent is parallel to the +Z reference.
    let points = vec![
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(0.0, 5.0, 0.0),
        Point3::new(0.0, 5.0, 3.0),
    ];
    let plan = |roll| SurfaceCurveSweepPlan {
        regions: vec![rectangle.clone()],
        points: points.clone(),
        entity_id: 1,
        roll,
    };
    let rmf = plan(None).evaluate().unwrap();
    let rolled = plan(Some(SectionRoll::Projected(Vector3::new(0.0, 0.0, 1.0))))
        .evaluate()
        .unwrap();
    assert_eq!(rolled.positions, rmf.positions);
    assert_eq!(rolled.indices, rmf.indices);

    // Control: on the straight +Y run alone the same reference does roll it.
    let straight = SurfaceCurveSweepPlan {
        points: points[..2].to_vec(),
        ..plan(Some(SectionRoll::Projected(Vector3::new(0.0, 0.0, 1.0))))
    };
    let straight_rmf = SurfaceCurveSweepPlan { roll: None, ..straight.clone() };
    assert_ne!(straight.evaluate().unwrap().positions, straight_rmf.evaluate().unwrap().positions);
}

/// A circle centred on the directrix is the same at any roll, so it keeps the
/// RMF and round sweeps (the #1485 duct elbows) do not move. An off-centre
/// circle does depend on the roll and takes the reference (#8437).
#[test]
fn only_a_centred_round_section_ignores_the_reference() {
    let roll_of = |profile: &str| {
        let source = format!(
            "#1=IFCCARTESIANPOINT((0.,0.,0.));\n\
            #2=IFCCARTESIANPOINT((0.,5.,0.));\n\
            #3=IFCPOLYLINE((#1,#2));\n\
            #5=IFCCARTESIANPOINT((0.,0.));\n\
            #6=IFCCARTESIANPOINT((0.3,0.));\n\
            #7=IFCAXIS2PLACEMENT2D(#5,$);\n\
            #8=IFCAXIS2PLACEMENT2D(#6,$);\n\
            #4={profile};\n\
            #9=IFCDIRECTION((0.,0.,1.));\n\
            #12=IFCAXIS2PLACEMENT3D(#1,#9,$);\n\
            #13=IFCPLANE(#12);\n\
            #10=IFCSURFACECURVESWEPTAREASOLID(#4,$,#3,$,$,#13);"
        );
        let mut decoder = EntityDecoder::new(&source);
        let entity = decoder.decode_by_id(10).unwrap();
        SurfaceCurveSweptAreaSolidProcessor::new(IfcSchema::new())
            .lower(&entity, &mut decoder, TessellationQuality::Medium)
            .unwrap()
            .unwrap()
            .roll
    };
    assert_eq!(roll_of("IFCCIRCLEPROFILEDEF(.AREA.,$,$,0.1)"), None);
    assert_eq!(roll_of("IFCCIRCLEPROFILEDEF(.AREA.,$,#7,0.1)"), None);
    assert_eq!(roll_of("IFCCIRCLEHOLLOWPROFILEDEF(.AREA.,$,#7,0.1,0.02)"), None);
    assert!(roll_of("IFCCIRCLEPROFILEDEF(.AREA.,$,#8,0.1)").is_some());
    assert!(roll_of("IFCRECTANGLEPROFILEDEF(.AREA.,$,#7,0.2,0.1)").is_some());
}
