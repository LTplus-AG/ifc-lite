// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! An `IfcGradientCurve` sampled as a swept solid's directrix through the
//! public `ProfileProcessor::get_directrix_points`: the samples follow the
//! vertical profile within the chord tolerance (0.5 mm), and parameter bounds
//! are horizontal distances along a distance-measured BaseCurve. Before, the
//! sampler returned the flat BaseCurve (z = 0) and refused parameter trims.
//! Swept solids along such curves are also meshed through the public element
//! path (`GeometryRouter::process_element`).

use ifc_lite_core::{EntityDecoder, IfcSchema};
use ifc_lite_geometry::{GeometryRouter, Mesh, Point3, ProfileProcessor, Result, TessellationQuality};

const CHORD_TOL_M: f64 = 5.0e-4;

/// A 400 m straight plan layout under a crest: a parabola from +2 % to -2 %
/// over the first 200 m (z = 100 + 0.02 s - 1e-4 s^2, back to 100 m), then a
/// constant -2 % grade.
const CREST: &str = "#1=IFCCARTESIANPOINT((0.,0.));\n\
    #2=IFCDIRECTION((1.,0.));\n\
    #3=IFCVECTOR(#2,1.);\n\
    #4=IFCLINE(#1,#3);\n\
    #5=IFCAXIS2PLACEMENT2D(#1,#2);\n\
    #6=IFCCURVESEGMENT(.CONTINUOUS.,#5,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(400.),#4);\n\
    #7=IFCCOMPOSITECURVE((#6),.F.);\n\
    #8=IFCCARTESIANPOINT((0.,100.));\n\
    #9=IFCDIRECTION((1.,0.02));\n\
    #10=IFCAXIS2PLACEMENT2D(#8,#9);\n\
    #11=IFCPOLYNOMIALCURVE(#5,(0.,1.),(0.,0.02,-1.E-4),$);\n\
    #12=IFCCURVESEGMENT(.CONTINUOUS.,#10,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(200.),#11);\n\
    #13=IFCCARTESIANPOINT((200.,100.));\n\
    #14=IFCDIRECTION((1.,-0.02));\n\
    #15=IFCAXIS2PLACEMENT2D(#13,#14);\n\
    #16=IFCCURVESEGMENT(.CONTSAMEGRADIENT.,#15,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(200.04),#4);\n\
    #17=IFCGRADIENTCURVE((#12,#16),.F.,#7,$);";

fn crest_elevation(s: f64) -> f64 {
    if s <= 200.0 { 100.0 + 0.02 * s - 1e-4 * s * s } else { 100.0 - 0.02 * (s - 200.0) }
}

fn points(source: &str, id: u32, start: Option<f64>, end: Option<f64>) -> Result<Vec<Point3<f64>>> {
    let mut decoder = EntityDecoder::new(source);
    let curve = decoder.decode_by_id(id).unwrap();
    ProfileProcessor::new(IfcSchema::new()).get_directrix_points(
        &curve,
        &mut decoder,
        start,
        end,
        TessellationQuality::Medium,
    )
}

/// The largest vertical gap between `profile` and the chords through
/// `points`, probed at 200 stations per chord.
fn worst_chord_error(points: &[Point3<f64>], profile: impl Fn(f64) -> f64) -> f64 {
    let mut worst: f64 = 0.0;
    for pair in points.windows(2) {
        for i in 1..200 {
            let t = i as f64 / 200.0;
            let x = pair[0].x + t * (pair[1].x - pair[0].x);
            let chord = pair[0].z + t * (pair[1].z - pair[0].z);
            worst = worst.max((profile(x) - chord).abs());
        }
    }
    worst
}

/// Every sample lies on the vertical profile and no chord strays more than
/// the tolerance from it. The parabola's 1 m sag is halved six times
/// (sag / 4^6 = 0.24 mm); the line after it stays one chord.
#[test]
fn gradient_directrix_samples_lie_on_the_profile_within_chord_tolerance() {
    let points = points(CREST, 17, None, None).unwrap();
    assert!(points[0].x.abs() < 1e-9 && (points.last().unwrap().x - 400.0).abs() < 1e-9);
    for p in &points {
        assert!(p.y.abs() < 1e-9);
        assert!((p.z - crest_elevation(p.x)).abs() < 1e-9, "{p:?}");
    }
    let worst = worst_chord_error(&points, crest_elevation);
    assert!(worst <= CHORD_TOL_M, "{worst}");
    assert_eq!(points.len(), 64 + 2);
}

/// A parameter bound is the BaseCurve's parameter: horizontal distance.
#[test]
fn parameter_trimmed_gradient_directrix_starts_and_ends_at_the_parameters() {
    let points = points(CREST, 17, Some(150.0), Some(300.0)).unwrap();
    let (first, last) = (points[0], *points.last().unwrap());
    assert!((first.x - 150.0).abs() < 1e-9 && (first.z - crest_elevation(150.0)).abs() < 1e-9);
    assert!((last.x - 300.0).abs() < 1e-9 && (last.z - 98.0).abs() < 1e-9);
    assert!(points.windows(2).all(|pair| pair[1].x > pair[0].x));
}

/// A length bound is measured along the 3D curve. On the vertical end the
/// whole arc of 5π m reaches station 10 at 110 m, and an end 6 cm of arc
/// short of it lies 0.006 rad before vertical. The last metre of station is
/// 4.51 m of arc, but a Simpson estimate counted it as about 375 m, and the
/// sweep stopped near station 9 (PR #9969 review). The top of the mesh is
/// the end ring's: its centre height plus the radius times cos(angle).
#[test]
fn length_bounds_up_to_the_vertical_end_reach_their_place_on_the_arc() {
    let (radius, section) = (10.0_f64, 0.05_f64);
    for arc in [5.0 * std::f64::consts::PI, 5.0 * std::f64::consts::PI - 0.06] {
        let mesh = element_mesh(&format!(
            "{VERTICAL_END}
            #25=IFCCIRCLEPROFILEDEF(.AREA.,$,$,{section:?});
            #26=IFCDIRECTION((0.,0.,1.));
            #30=IFCFIXEDREFERENCESWEPTAREASOLID(#25,$,#20,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE({arc:?}),#26);"
        ));
        let angle = arc / radius;
        let expected = 100.0 + radius * (1.0 - angle.cos()) + section * angle.cos();
        let top = mesh.positions.chunks_exact(3).map(|p| p[2] as f64).fold(f64::MIN, f64::max);
        assert!((top - expected).abs() < 1e-4, "arc {arc}: top at {top}, expected {expected}");
    }
}

/// The parameter of a 2-point IfcPolyline BaseCurve is 0..1 over its 1000 m,
/// not distance. That mapping is not read, so parameter bounds on it are
/// refused rather than cut at 0.3..0.6 m. Unbounded, the curve still follows
/// its 10 % grade to 200 m.
#[test]
fn parameter_trim_on_a_base_that_is_not_measured_by_distance_is_refused() {
    let source = "#1=IFCCARTESIANPOINT((0.,0.));\n\
        #2=IFCDIRECTION((1.,0.));\n\
        #3=IFCVECTOR(#2,1.);\n\
        #4=IFCLINE(#1,#3);\n\
        #5=IFCAXIS2PLACEMENT2D(#1,#2);\n\
        #13=IFCCARTESIANPOINT((1000.,0.));\n\
        #7=IFCPOLYLINE((#1,#13));\n\
        #8=IFCCARTESIANPOINT((0.,100.));\n\
        #9=IFCDIRECTION((1.,0.1));\n\
        #10=IFCAXIS2PLACEMENT2D(#8,#9);\n\
        #11=IFCCURVESEGMENT(.CONTINUOUS.,#10,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(1100.),#4);\n\
        #12=IFCGRADIENTCURVE((#11),.F.,#7,$);";
    let trimmed = points(source, 12, Some(0.3), Some(0.6));
    assert!(trimmed.as_ref().map_or(true, |p| p.is_empty()), "{trimmed:?}");
    let whole = points(source, 12, None, None).unwrap();
    assert!((whole.last().unwrap().z - 200.0).abs() < 1e-9, "{:?}", whole.last());
}

/// A final circular vertical segment (R 100 m, level start, 100 m of arc,
/// so 84.147 m of plan and a 57 degree end grade) has a curvature in station
/// that grows towards its end. Its chords still stay within tolerance.
#[test]
fn steep_circular_profile_stays_within_chord_tolerance() {
    let source = "#1=IFCCARTESIANPOINT((0.,0.));\n\
        #2=IFCDIRECTION((1.,0.));\n\
        #3=IFCVECTOR(#2,1.);\n\
        #4=IFCLINE(#1,#3);\n\
        #5=IFCAXIS2PLACEMENT2D(#1,#2);\n\
        #6=IFCCURVESEGMENT(.CONTINUOUS.,#5,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(200.),#4);\n\
        #7=IFCCOMPOSITECURVE((#6),.F.);\n\
        #8=IFCCARTESIANPOINT((0.,100.));\n\
        #10=IFCAXIS2PLACEMENT2D(#8,#2);\n\
        #11=IFCCIRCLE(#5,100.);\n\
        #12=IFCCURVESEGMENT(.CONTINUOUS.,#10,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(100.),#11);\n\
        #13=IFCGRADIENTCURVE((#12),.F.,#7,$);";
    let end = 100.0 * 1.0_f64.sin();
    let profile = |s: f64| {
        if s <= end {
            100.0 + 100.0 * (1.0 - (1.0 - (s / 100.0).powi(2)).sqrt())
        } else {
            100.0 + 100.0 * (1.0 - 1.0_f64.cos()) + 1.0_f64.tan() * (s - end)
        }
    };
    let points = points(source, 13, None, None).unwrap();
    for p in &points {
        assert!((p.z - profile(p.x)).abs() < 1e-6, "{p:?}");
    }
    let worst = worst_chord_error(&points, profile);
    assert!(worst <= CHORD_TOL_M, "{worst}");
}

/// Mesh `items` (curve, profile and solid entities, the solid as #30) as the
/// body of a building element proxy, through the public element path.
fn element_mesh(items: &str) -> Mesh {
    let source = format!(
        "{items}\n\
        #40=IFCCARTESIANPOINT((0.,0.,0.));\n\
        #41=IFCAXIS2PLACEMENT3D(#40,$,$);\n\
        #42=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#41,$);\n\
        #43=IFCSHAPEREPRESENTATION(#42,'Body','AdvancedSweptSolid',(#30));\n\
        #44=IFCPRODUCTDEFINITIONSHAPE($,$,(#43));\n\
        #45=IFCLOCALPLACEMENT($,#41);\n\
        #46=IFCBUILDINGELEMENTPROXY('0g1v8xyXT4tA5DJ2bk3hJs',$,$,$,$,#45,#44,$,$);"
    );
    let index = ifc_lite_core::build_entity_index(&source);
    let mut decoder = EntityDecoder::with_index(&source, index);
    let router = GeometryRouter::with_units(&source, &mut decoder);
    let element = decoder.decode_by_id(46).unwrap();
    let mesh = router.process_element(&element, &mut decoder).unwrap();
    assert!(!mesh.indices.is_empty(), "no mesh");
    assert!(mesh.positions.iter().chain(&mesh.normals).all(|c| c.is_finite()), "non-finite vertex or normal");
    mesh
}

/// A plan heading +Y under a final circular vertical segment of radius 10 m
/// from a level start, 5π m of arc: a quarter circle that ends vertical at
/// station 10, at 110 m (#20).
const VERTICAL_END: &str = "#1=IFCCARTESIANPOINT((0.,0.));\n\
    #2=IFCDIRECTION((1.,0.));\n\
    #3=IFCVECTOR(#2,1.);\n\
    #4=IFCLINE(#1,#3);\n\
    #5=IFCAXIS2PLACEMENT2D(#1,#2);\n\
    #16=IFCDIRECTION((0.,1.));\n\
    #17=IFCAXIS2PLACEMENT2D(#1,#16);\n\
    #6=IFCCURVESEGMENT(.CONTINUOUS.,#17,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(10.),#4);\n\
    #7=IFCCOMPOSITECURVE((#6),.F.);\n\
    #8=IFCCARTESIANPOINT((0.,100.));\n\
    #9=IFCAXIS2PLACEMENT2D(#8,#2);\n\
    #11=IFCCIRCLE(#5,10.);\n\
    #12=IFCCURVESEGMENT(.CONTINUOUS.,#9,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(15.707963267948966),#11);\n\
    #20=IFCGRADIENTCURVE((#12),.F.,#7,$);";

/// A swept disk and a round FixedReference sweep up to the vertical end mesh
/// finite positions and normals and reach its 110 m top (PR #9969 review).
/// Before, the evaluated tangent there was inf / inf and the end rings NaN.
#[test]
fn sweeps_up_to_a_vertical_profile_end_mesh_finite_vertices() {
    let solids = [
        "#30=IFCSWEPTDISKSOLID(#20,0.05,$,$,$);",
        "#25=IFCCIRCLEPROFILEDEF(.AREA.,$,$,0.05);\n#26=IFCDIRECTION((0.,0.,1.));\n\
         #30=IFCFIXEDREFERENCESWEPTAREASOLID(#25,$,#20,$,$,#26);",
    ];
    for solid in solids {
        let mesh = element_mesh(&format!("{VERTICAL_END}\n{solid}"));
        let top = mesh.positions.chunks_exact(3).map(|p| p[2]).fold(f32::MIN, f32::max);
        assert!((top - 110.0).abs() < 0.01, "{solid}: top at {top}");
    }
}

/// The crest (#17) swept by a round FixedReference solid under a Position
/// that maps (x, y, z) to (-z, y, x): the placed tangent is vertical at the
/// crest and tips through it. Every wall triangle stays on the tube, at least
/// half the radius from the directrix; a section frame that flips between
/// two rings joins each vertex to the far side of the next ring, and those
/// triangles cross the axis (PR #9969 review).
#[test]
fn a_rotated_gradient_crest_meshes_a_tube_without_a_twist() {
    let mesh = element_mesh(&format!(
        "{CREST}\n\
        #21=IFCCARTESIANPOINT((0.,0.,0.));\n\
        #22=IFCDIRECTION((-1.,0.,0.));\n\
        #23=IFCDIRECTION((0.,0.,1.));\n\
        #24=IFCAXIS2PLACEMENT3D(#21,#22,#23);\n\
        #25=IFCCIRCLEPROFILEDEF(.AREA.,$,$,0.5);\n\
        #26=IFCDIRECTION((0.,0.,1.));\n\
        #30=IFCFIXEDREFERENCESWEPTAREASOLID(#25,#24,#17,IFCPARAMETERVALUE(0.),IFCPARAMETERVALUE(200.),#26);"
    ));
    let vertex = |i: u32| {
        let p = &mesh.positions[3 * i as usize..3 * i as usize + 3];
        [p[0] as f64, p[1] as f64, p[2] as f64]
    };
    let mut walls = 0;
    for triangle in mesh.indices.chunks_exact(3) {
        let [a, b, c] = [vertex(triangle[0]), vertex(triangle[1]), vertex(triangle[2])];
        let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
        let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        let length = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        // The placed tangent is within 1.2 degrees of +Z; caps face along it.
        if length == 0.0 || (n[2] / length).abs() > 0.5 {
            continue;
        }
        walls += 1;
        let centroid = [(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0, (a[2] + b[2] + c[2]) / 3.0];
        // The directrix point at that height: local (s, 0, z(s)) placed at (-z(s), 0, s).
        let off_axis = (centroid[0] + crest_elevation(centroid[2])).hypot(centroid[1]);
        assert!(off_axis > 0.25, "a wall triangle crosses the axis at {centroid:?} ({off_axis} m off)");
    }
    assert!(walls > 100, "{walls} wall triangles");
}
