// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::processors::{SurfaceCurveSweptAreaSolidProcessor, SweptDiskSolidProcessor};
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
        // Any further fields as a plain (non-gradient) plan has them.
        ..lower("IFCSURFACECURVESWEPTAREASOLID")
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
        ..lower("IFCSURFACECURVESWEPTAREASOLID")
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
/// A 1000 m straight plan layout under a constant `grade` from 100 m, as an
/// IFC4x3 `IfcGradientCurve`, swept with a 3 x 0.5 rectangle whose 3 m side
/// the FixedReference (+Z) stands up. `range` is the solid's
/// StartParam/EndParam.
fn gradient_sweep(grade: f64, range: &str) -> String {
    format!(
        "#1=IFCCARTESIANPOINT((0.,0.));\n\
        #2=IFCDIRECTION((1.,0.));\n\
        #3=IFCVECTOR(#2,1.);\n\
        #4=IFCLINE(#1,#3);\n\
        #5=IFCAXIS2PLACEMENT2D(#1,#2);\n\
        #6=IFCCURVESEGMENT(.CONTINUOUS.,#5,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(1000.),#4);\n\
        #7=IFCCOMPOSITECURVE((#6),.F.);\n\
        #8=IFCCARTESIANPOINT((0.,100.));\n\
        #9=IFCDIRECTION((1.,{grade:?}));\n\
        #11=IFCAXIS2PLACEMENT2D(#8,#9);\n\
        #12=IFCCURVESEGMENT(.CONTINUOUS.,#11,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(1100.),#4);\n\
        #13=IFCGRADIENTCURVE((#12),.F.,#7,$);\n\
        #14=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,3.,0.5);\n\
        #15=IFCDIRECTION((0.,0.,1.));\n\
        #10=IFCFIXEDREFERENCESWEPTAREASOLID(#14,$,#13,{range},#15);"
    )
}

fn assert_near(actual: [f32; 3], expected: [f64; 3]) {
    for axis in 0..3 {
        assert!((actual[axis] as f64 - expected[axis]).abs() < 1e-3, "{actual:?} != {expected:?}");
    }
}

/// Expected box of `gradient_sweep(grade, ..)` between horizontal stations
/// `a` and `b`. The grade tilts Axis1 (the projected FixedReference) by
/// atan(grade), so the 1.5 m half-height reaches 1.5 / sqrt(1 + grade^2) up
/// and `grade` times that back along x.
fn gradient_box(grade: f64, a: f64, b: f64) -> ([f64; 3], [f64; 3]) {
    let half = 1.5 / (1.0 + grade * grade).sqrt();
    (
        [a - grade * half, -0.25, 100.0 + grade * a - half],
        [b + grade * half, 0.25, 100.0 + grade * b + half],
    )
}

/// An `IfcGradientCurve` directrix carries its elevation: the section rides
/// the 100 -> 110 m profile instead of the flat BaseCurve at z = 0.
#[test]
fn gradient_curve_directrix_sweeps_along_the_vertical_profile() {
    let (min, max) = bounds_of(&gradient_sweep(0.01, "$,$"));
    let (lo, hi) = gradient_box(0.01, 0.0, 1000.0);
    assert_near(min, lo);
    assert_near(max, hi);
}

/// An `IfcParameterValue` bound is the gradient curve's parameter, which is
/// its BaseCurve's: horizontal distance along the plan. 300..600 sweeps that
/// stretch at its own elevations. It used to fall through to the plain
/// composite-curve trim, which cannot read an IfcCurveSegment, and was refused.
#[test]
fn parameter_trimmed_gradient_curve_directrix_sweeps_the_horizontal_stretch() {
    let source = gradient_sweep(0.1, "IFCPARAMETERVALUE(300.),IFCPARAMETERVALUE(600.)");
    let (min, max) = bounds_of(&source);
    let (lo, hi) = gradient_box(0.1, 300.0, 600.0);
    assert_near(min, lo);
    assert_near(max, hi);
}

/// An `IfcLengthMeasure` bound is a length along the 3D directrix. On a 10 %
/// grade, 300 and 600 m along it are 300 / sqrt(1.01) = 298.511 and 597.022 m
/// along the plan, not 300 and 600.
#[test]
fn length_trimmed_gradient_curve_directrix_measures_along_the_slope() {
    let source = gradient_sweep(0.1, "IFCLENGTHMEASURE(300.),IFCLENGTHMEASURE(600.)");
    let (min, max) = bounds_of(&source);
    let along = 1.01_f64.sqrt();
    let (lo, hi) = gradient_box(0.1, 300.0 / along, 600.0 / along);
    assert_near(min, lo);
    assert_near(max, hi);
}

/// A 400 m straight plan under a crest `IfcGradientCurve` (#20): a parabola
/// from +2 % to -2 % over 200 m (z = 100 + 0.02 s - 1e-4 s^2, flat at
/// s = 100, z = 101), then -2 %, followed by `solid` (#10, along #20).
fn crest(solid: &str) -> String {
    format!(
        "#1=IFCCARTESIANPOINT((0.,0.));
        #2=IFCDIRECTION((1.,0.));
        #3=IFCVECTOR(#2,1.);
        #4=IFCLINE(#1,#3);
        #5=IFCAXIS2PLACEMENT2D(#1,#2);
        #6=IFCCURVESEGMENT(.CONTINUOUS.,#5,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(400.),#4);
        #7=IFCCOMPOSITECURVE((#6),.F.);
        #8=IFCCARTESIANPOINT((0.,100.));
        #9=IFCDIRECTION((1.,0.02));
        #11=IFCAXIS2PLACEMENT2D(#8,#9);
        #12=IFCPOLYNOMIALCURVE(#5,(0.,1.),(0.,0.02,-1.E-4),$);
        #13=IFCCURVESEGMENT(.CONTINUOUS.,#11,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(200.),#12);
        #16=IFCCARTESIANPOINT((200.,100.));
        #17=IFCDIRECTION((1.,-0.02));
        #18=IFCAXIS2PLACEMENT2D(#16,#17);
        #19=IFCCURVESEGMENT(.CONTSAMEGRADIENT.,#18,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(200.04),#4);
        #20=IFCGRADIENTCURVE((#13,#19),.F.,#7,$);
        {solid}"
    )
}

/// The vertices of a round section of `radius` that lie within 0.1 m of the
/// crest station (x = 100), checked to sit on the circle around the crest
/// point (100, 0, 101) and returned as their x offsets from 100. Disc-cap
/// centres are skipped.
fn round_section_at_crest(positions: &[f32], radius: f64) -> Vec<f64> {
    let mut offsets = Vec::new();
    for p in positions.chunks_exact(3) {
        let (x, y, z) = (p[0] as f64, p[1] as f64, p[2] as f64);
        let distance = ((x - 100.0).powi(2) + y * y + (z - 101.0).powi(2)).sqrt();
        if (x - 100.0).abs() < 0.1 && distance > 0.5 * radius {
            assert!((distance - radius).abs() < 1e-4, "({x}, {y}, {z}) is off the crest circle");
            offsets.push(x - 100.0);
        }
    }
    assert!(offsets.len() >= 8, "no section at the crest: {offsets:?}");
    offsets
}

fn crest_sweep(profile: &str, range: &str) -> Mesh {
    let source = crest(&format!(
        "#14={profile};
        #15=IFCDIRECTION((0.,0.,1.));
        #10=IFCFIXEDREFERENCESWEPTAREASOLID(#14,$,#20,{range},#15);"
    ));
    let mut decoder = EntityDecoder::new(&source);
    let entity = decoder.decode_by_id(10).unwrap();
    SurfaceCurveSweptAreaSolidProcessor::new(IfcSchema::new())
        .lower(&entity, &mut decoder, TessellationQuality::Medium)
        .unwrap()
        .unwrap()
        .evaluate()
        .unwrap()
}

/// Two sweeps that meet on a crest share its tangent (grade 0 there), so the
/// end cap of the first and the start cap of the second coincide. With
/// tangents taken from the chords the two caps leaned apart by about a
/// millimetre at the top of a 3 m section: a visible seam.
#[test]
fn gradient_sweeps_meeting_at_a_point_share_its_section() {
    let rectangle = "IFCRECTANGLEPROFILEDEF(.AREA.,$,$,3.,0.5)";
    let first = crest_sweep(rectangle, "IFCPARAMETERVALUE(0.),IFCPARAMETERVALUE(100.)");
    let second = crest_sweep(rectangle, "IFCPARAMETERVALUE(100.),IFCPARAMETERVALUE(200.)");
    // One ring of the 4-point rectangle per sample: the last ring of the
    // first sweep against the first ring of the second.
    let ring = 4 * 3;
    let end_cap = &first.positions[first.positions.len() - ring..];
    let start_cap = &second.positions[..ring];
    for (a, b) in end_cap.iter().zip(start_cap) {
        assert!((a - b).abs() < 1e-5, "{end_cap:?} != {start_cap:?}");
    }
    // The shared section stands upright: grade 0 at the crest.
    let xs: Vec<f32> = end_cap.chunks_exact(3).map(|p| p[0]).collect();
    assert!(xs.iter().all(|x| (x - 100.0).abs() < 1e-4), "{xs:?}");
}

/// A centred round section has no roll and keeps the rotation-minimising
/// frame, which also takes the curve's own tangents: both sweeps end on the
/// same upright circle at the crest. With chord tangents each cap leaned by
/// the slope of its last chord (about 0.16 mm at the top of a 0.5 m radius).
#[test]
fn round_gradient_sweeps_meeting_at_a_point_share_its_section() {
    let circle = "IFCCIRCLEPROFILEDEF(.AREA.,$,$,0.5)";
    for range in [
        "IFCPARAMETERVALUE(0.),IFCPARAMETERVALUE(100.)",
        "IFCPARAMETERVALUE(100.),IFCPARAMETERVALUE(200.)",
    ] {
        let offsets = round_section_at_crest(&crest_sweep(circle, range).positions, 0.5);
        assert!(offsets.iter().all(|x| x.abs() < 3e-5), "{range}: section leans {offsets:?}");
    }
}

/// An `IfcSweptDiskSolid` along the same crest builds its rings in the
/// rotation-minimising frame of the curve's own tangents too, so two disks
/// trimmed at the crest meet on one upright circle.
#[test]
fn gradient_swept_disks_meeting_at_a_point_share_its_section() {
    for range in ["0.,100.", "100.,200."] {
        let source = crest(&format!("#10=IFCSWEPTDISKSOLID(#20,0.5,$,{range});"));
        let mut decoder = EntityDecoder::new(&source);
        let entity = decoder.decode_by_id(10).unwrap();
        let mesh = SweptDiskSolidProcessor::new(IfcSchema::new())
            .lower(&entity, &mut decoder, TessellationQuality::Medium)
            .unwrap()
            .unwrap()
            .evaluate();
        let offsets = round_section_at_crest(&mesh.positions, 0.5);
        assert!(offsets.iter().all(|x| x.abs() < 3e-5), "{range}: section leans {offsets:?}");
    }
}

/// A plan bending left on a 200 m radius arc under a constant 2 % grade from
/// 10 m (#20), followed by `solid` (#30, along #20).
fn bend(solid: &str) -> String {
    format!(
        "#1=IFCCARTESIANPOINT((0.,0.));
        #2=IFCDIRECTION((1.,0.));
        #3=IFCAXIS2PLACEMENT2D(#1,$);
        #4=IFCCIRCLE(#3,200.);
        #5=IFCAXIS2PLACEMENT2D(#1,#2);
        #6=IFCCURVESEGMENT(.CONTINUOUS.,#5,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(200.),#4);
        #7=IFCCOMPOSITECURVE((#6),.F.);
        #8=IFCVECTOR(#2,1.);
        #9=IFCLINE(#1,#8);
        #10=IFCCARTESIANPOINT((0.,10.));
        #11=IFCDIRECTION((1.,0.02));
        #12=IFCAXIS2PLACEMENT2D(#10,#11);
        #13=IFCCURVESEGMENT(.CONTINUOUS.,#12,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(210.),#9);
        #20=IFCGRADIENTCURVE((#13),.F.,#7,$);
        {solid}"
    )
}

/// Vertices of `a` that coincide with a vertex of `b`.
fn shared_vertices(a: &[f32], b: &[f32]) -> usize {
    a.chunks_exact(3)
        .filter(|p| b.chunks_exact(3).any(|q| (0..3).all(|i| (p[i] - q[i]).abs() < 1e-4)))
        .count()
}

/// On a bend, a rotation-minimising frame turns with the curve from wherever
/// the sweep starts, so two round sweeps trimmed at the same station put
/// their ring vertices at different angles there. The frames of a curve with
/// evaluated tangents depend on the station alone, so the shared rings are
/// the same set of vertices.
#[test]
fn round_gradient_sweeps_on_a_bend_place_the_same_ring_where_they_meet() {
    let disk = |range: &str| {
        let source = bend(&format!("#30=IFCSWEPTDISKSOLID(#20,0.5,$,{range});"));
        let mut decoder = EntityDecoder::new(&source);
        let entity = decoder.decode_by_id(30).unwrap();
        SweptDiskSolidProcessor::new(IfcSchema::new())
            .lower(&entity, &mut decoder, TessellationQuality::Medium)
            .unwrap()
            .unwrap()
            .evaluate()
            .positions
    };
    let round = |range: &str| {
        let source = bend(&format!(
            "#31=IFCCIRCLEPROFILEDEF(.AREA.,$,$,0.5);
            #32=IFCDIRECTION((0.,0.,1.));
            #30=IFCFIXEDREFERENCESWEPTAREASOLID(#31,$,#20,{range},#32);"
        ));
        let mut decoder = EntityDecoder::new(&source);
        let entity = decoder.decode_by_id(30).unwrap();
        SurfaceCurveSweptAreaSolidProcessor::new(IfcSchema::new())
            .lower(&entity, &mut decoder, TessellationQuality::Medium)
            .unwrap()
            .unwrap()
            .evaluate()
            .unwrap()
            .positions
    };
    let (first, second) = (disk("0.,100."), disk("100.,200."));
    assert!(shared_vertices(&first, &second) >= 24, "swept disks share {} vertices", shared_vertices(&first, &second));
    let (first, second) = (
        round("IFCPARAMETERVALUE(0.),IFCPARAMETERVALUE(100.)"),
        round("IFCPARAMETERVALUE(100.),IFCPARAMETERVALUE(200.)"),
    );
    assert!(shared_vertices(&first, &second) >= 8, "round sweeps share {} vertices", shared_vertices(&first, &second));
}
