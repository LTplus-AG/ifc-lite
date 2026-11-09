// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 M11-F, SMLib-free: source-surface attribution on hand triangles placed on
//! hand-derived faces of real lowered requests (no kernel, no mock receipts).
#[allow(dead_code)]
#[path = "../src/element/session_retained/presentation/face_attribution.rs"]
mod face_attribution;
#[allow(dead_code)]
#[path = "../src/element/session_retained/presentation/face_surfaces.rs"]
mod face_surfaces;
#[path = "../src/element/session_retained/presentation/face_coincidence.rs"]
mod face_coincidence;
#[allow(dead_code)]
#[path = "../src/element/session_retained/presentation/face_curve.rs"]
mod face_curve;
use face_attribution::{candidates, resolve, Choice, Extent, Halt, Operand, Role, SourceFace, Support, Unproven};
use ifc_lite_geometry::resource::{self, Dimension, ProgramStop};
use ifc_lite_processing::retained_requests::RetainedSources;

const CHORD: f64 = 0.001;
const IDENTITY: [f64; 16] = [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.];
const HEADER: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,(#2),#3);#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);#7=IFCLOCALPLACEMENT($,#5);#15=IFCDIRECTION((0.,0.,1.));";

/// The one admitted source's operand, placed at `from_part`.
fn operand(text: &str, disk: bool, sign: f64, from_part: [f64; 16]) -> Operand {
    let sources = if disk { RetainedSources::swept_disks(text.as_bytes(), None) }
        else { RetainedSources::extrusions(text.as_bytes(), None) };
    assert_eq!(sources.admitted.len(), 1, "{:?} {:?}", sources.refused, sources.diagnostics);
    let request = sources.admitted[0].prepare(1).unwrap();
    let (faces, region) = face_surfaces::faces(request.recipe(), request.payload()).unwrap();
    Operand { item: request.recipe().solid_id(), via: 0, from_part, sign, stretch: 1., faces, region, rows_identify_faces: false, request: None, subtracted: false }
}
/// One extruded wall #10 (solid #13) placed at `origin`, polyline profile in authored order.
fn wall(points: &[[f64; 2]], depth: f64, origin: [f64; 3]) -> String {
    let ids: Vec<String> = (0..points.len()).map(|i| format!("#{}", 20 + i)).collect();
    let mut text = format!("{HEADER}#8=IFCLOCALPLACEMENT($,#9);#9=IFCAXIS2PLACEMENT3D(#17,$,$);#17=IFCCARTESIANPOINT(({:?},{:?},{:?}));
#10=IFCWALL('w',$,'Wall',$,$,#8,#11,$,$);#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));
#12=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#13));#13=IFCEXTRUDEDAREASOLID(#14,#5,#15,{depth:?});
#14=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#16);#16=IFCPOLYLINE(({},#20));", origin[0], origin[1], origin[2], ids.join(","));
    for (i, p) in points.iter().enumerate() { text += &format!("#{}=IFCCARTESIANPOINT(({:?},{:?}));", 20 + i, p[0], p[1]); }
    text + "ENDSEC;END-ISO-10303-21;"
}
const BOX: [[f64; 2]; 4] = [[0., 0.], [4., 0.], [4., 2.], [0., 2.]];
const UNIT: [[f64; 2]; 4] = [[0., 0.], [1., 0.], [1., 1.], [0., 1.]];
/// A triangle wound so its facet normal is `outward`.
fn tri(a: [f64; 3], b: [f64; 3], c: [f64; 3], outward: [f64; 3]) -> [[f64; 3]; 3] {
    let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] >= 0. { [a, b, c] } else { [a, c, b] }
}
fn proof(halt: Halt) -> Unproven {
    match halt { Halt::Unproven(unproven) => unproven, Halt::Stopped(stop) => panic!("no budget is active: {stop:?}") }
}
/// One kernel face made of `triangles`: its single resolved source face.
fn face(operands: &[Operand], triangles: &[[[f64; 3]; 3]]) -> Result<Choice, Unproven> {
    resolve(operands, &triangles.iter().map(|t| candidates(operands, t, CHORD)).collect::<Result<Vec<_>, _>>().map_err(proof)?, CHORD)
}
fn key(operands: &[Operand], corners: [[f64; 3]; 3]) -> Result<(u32, String), Unproven> {
    face(operands, &[corners]).map(|(o, f)| (operands[o].item, operands[o].faces[f].role.to_string()))
}
fn translation(x: f64, y: f64, z: f64) -> [f64; 16] {
    let mut m = IDENTITY;
    m[12..15].copy_from_slice(&[x, y, z]);
    m
}

#[test]
fn m11_f_7955_reversed_profile_keeps_authored_side_order_and_outward_faces() {
    // Clockwise as authored: the request reverses the loop, the roles must not.
    let host = [operand(&wall(&[[0., 0.], [0., 2.], [4., 2.], [4., 0.]], 3., [0.; 3]), false, 1., IDENTITY)];
    let sides = [([0., 0.], [0., 2.], [-1., 0.]), ([0., 2.], [4., 2.], [0., 1.]),
        ([4., 2.], [4., 0.], [1., 0.]), ([4., 0.], [0., 0.], [0., -1.])];
    for (k, (a, b, n)) in sides.into_iter().enumerate() {
        let corners = tri([a[0], a[1], 0.], [b[0], b[1], 0.], [a[0], a[1], 3.], [n[0], n[1], 0.]);
        assert_eq!(key(&host, corners), Ok((13, format!("side(0,{k})"))), "authored edge {k}");
        // The same triangle facing inward is no outward source face: never guessed.
        assert_eq!(key(&host, [corners[0], corners[2], corners[1]]), Err(Unproven::Unattributed { entity: Some(13) }));
    }
    let cap = |z: f64, n: f64| tri([1., 0.5, z], [3., 0.5, z], [2., 1.5, z], [0., 0., n]);
    assert_eq!(key(&host, cap(0., -1.)), Ok((13, "cap(start)".into())));
    assert_eq!(key(&host, cap(3., 1.)), Ok((13, "cap(end)".into())));
    assert_eq!(key(&host, cap(1.5, 1.)), Err(Unproven::Unattributed { entity: Some(13) }), "interior plane");
}

#[test]
fn m11_f_7955_cap_fan_and_rim_ears_are_not_cylinder_walls() {
    let text = format!("{HEADER}#10=IFCCOLUMN('c',$,'Column',$,$,#7,#11,$,$);#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));
#12=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#13));#13=IFCEXTRUDEDAREASOLID(#14,#5,#15,1.);
#14=IFCCIRCLEPROFILEDEF(.AREA.,$,$,0.5);ENDSEC;END-ISO-10303-21;");
    let column = [operand(&text, false, 1., IDENTITY)];
    let rim = |degrees: f64, z: f64| { let t = degrees.to_radians(); [0.5 * t.cos(), 0.5 * t.sin(), z] };
    // A wall facet across 4 degrees: centroid within the 1 mm chord of r = 0.5 m.
    assert_eq!(key(&column, tri(rim(0., 0.), rim(4., 0.), rim(0., 1.), [1., 0.035, 0.])), Ok((13, "side(0,0)".into())));
    // Cap fan: rim vertices, centroid far inside the cylinder.
    assert_eq!(key(&column, tri([0., 0., 1.], rim(0., 1.), rim(4., 1.), [0., 0., 1.])), Ok((13, "cap(end)".into())));
    // Rim ear: all three vertices AND the centroid lie on the wall; only the normal excludes it.
    assert_eq!(key(&column, tri(rim(0., 1.), rim(2., 1.), rim(4., 1.), [0., 0., 1.])), Ok((13, "cap(end)".into())));
}

#[test]
fn m11_f_7955_flush_coincident_faces_go_to_the_left_host_operand() {
    let host = operand(&wall(&BOX, 3., [0.; 3]), false, 1., IDENTITY);
    let cutter = |origin: [f64; 3], depth: f64| {
        let mut cutter = operand(&wall(&UNIT, depth, origin), false, -1., translation(-origin[0], -origin[1], -origin[2]));
        cutter.via = 99;
        cutter
    };
    // The cutter's base lies ON the host top (flush, outside): subtracted, its reversed base faces +Z.
    let operands = [host.clone(), cutter([1., 0.5, 3.], 1.)];
    let flush = tri([1.2, 0.6, 3.], [1.8, 0.6, 3.], [1.5, 1.4, 3.], [0., 0., 1.]);
    let choice = face(&operands, &[flush]).unwrap();
    assert_eq!((operands[choice.0].via, operands[choice.0].faces[choice.1].role.to_string()), (0, "cap(end)".into()),
        "both bounded faces hold the triangle: the LEFT (host) operand keeps it");
    // A cutter sunk 1 m into the host: its reversed side is the reveal, keyed through the opening.
    let operands = [host, cutter([1., 0.5, 2.], 2.)];
    let reveal = tri([1., 0.6, 2.4], [1., 1.4, 2.4], [1., 0.6, 2.9], [1., 0., 0.]);
    let (o, f) = face(&operands, &[reveal]).unwrap();
    assert_eq!((operands[o].via, operands[o].faces[f].role), (99, Role::Side { boundary: 0, segment: 3 }));
    let floor = tri([1.2, 0.6, 2.], [1.8, 0.6, 2.], [1.5, 1.4, 2.], [0., 0., 1.]);
    let (o, f) = face(&operands, &[floor]).unwrap();
    assert_eq!((operands[o].via, operands[o].faces[f].role), (99, Role::Cap { end: false }));
}

#[test]
fn m11_f_7955_disjoint_coplanar_union_faces_keep_their_own_operand() {
    let text = wall(&BOX, 3., [0.; 3]);
    let mut right = operand(&text, false, 1., translation(-5., 0., 0.));
    right.item = 77;
    let operands = [operand(&text, false, 1., IDENTITY), right];
    // Same top plane as the left operand, but only the right operand's bounded cap holds it.
    assert_eq!(key(&operands, tri([6., 0.5, 3.], [8., 0.5, 3.], [7., 1.5, 3.], [0., 0., 1.])), Ok((77, "cap(end)".into())));
    assert_eq!(key(&operands, tri([1., 0.5, 3.], [3., 0.5, 3.], [2., 1.5, 3.], [0., 0., 1.])), Ok((13, "cap(end)".into())));
}

#[test]
fn m11_f_7955_non_coincident_candidates_refuse_as_ambiguous() {
    let source = |role, support| SourceFace { role, support, extent: Extent::Wall };
    let lone = |item, faces| Operand { item, via: 0, from_part: IDENTITY, sign: 1., stretch: 1., faces, region: None , rows_identify_faces: false, request: None, subtracted: false };
    // x = 1 is tangent to the r = 1 cylinder along y = 0: a sliver there lies on both.
    let operands = [lone(1, vec![source(Role::Cap { end: true }, Support::Plane { origin: [1., 0., 0.], normal: [1., 0., 0.] })]),
        lone(2, vec![source(Role::Side { boundary: 0, segment: 0 },
            Support::Cylinder { center: [0., 0.], radius: 1., generator: [0., 0., 1.], outward: 1. })])];
    let sliver = tri([1., -1e-4, 0.], [1., 1e-4, 0.], [1., 0., 1.], [1., 0., 0.]);
    assert_eq!(face(&operands, &[sliver]), Err(Unproven::Ambiguous { entity: Some(1) }));
    assert_eq!(face(&operands, &[tri([5., 5., 5.], [6., 5., 5.], [5., 6., 5.], [0., 0., 1.])]),
        Err(Unproven::Unattributed { entity: Some(1) }));
}

#[test]
fn m11_f_7955_kernel_face_merging_two_coincident_cutters_keeps_the_left_one() {
    // AC20-FZK-Haus shape: one opening is two abutting boxes (each half the wall), and the kernel
    // merges their coplanar jambs into ONE face whose triangles each lie in one box only.
    let host = operand(&wall(&BOX, 3., [0.; 3]), false, 1., IDENTITY);
    let half = |y: f64| {
        let mut cutter = operand(&wall(&UNIT, 1., [1., y, 1.]), false, -1., translation(-1., -y, -1.));
        cutter.via = 99;
        cutter.item = 100 + (y * 2.) as u32;
        cutter
    };
    let operands = [host, half(0.), half(1.)];
    // The jamb at x = 1 (cutter edge 3) across both halves, split by the kernel's own diagonal.
    let jamb = [tri([1., 0.2, 1.], [1., 1.8, 1.], [1., 0.2, 2.], [1., 0., 0.]), tri([1., 1.8, 1.], [1., 1.8, 2.], [1., 0.2, 2.], [1., 0., 0.])];
    assert_eq!(candidates(&operands, &jamb[0], CHORD).unwrap().matches.iter().filter(|c| c.1).count(), 1, "centroid in one half");
    let (o, f) = face(&operands, &jamb).unwrap();
    assert_eq!((operands[o].item, operands[o].faces[f].role), (100, Role::Side { boundary: 0, segment: 3 }),
        "coincident cutters: the left one, uniformly across the kernel face");
    // A kernel that splits the jamb keys each half by its own cutter: the face_bands
    // oracle ("connected coincident faces go to the earliest cut") rejects that kernel.
    assert_eq!(face(&operands, &jamb[1..]).map(|(o, _)| operands[o].item), Ok(102));
}

#[test]
fn m11_f_7955_zero_area_triangles_never_choose_a_face() {
    let host = [operand(&wall(&BOX, 3., [0.; 3]), false, 1., IDENTITY)];
    // A point on the box corner lies on three planes: alone it is no evidence.
    let point = [[0.; 3]; 3];
    assert!(!candidates(&host, &point, CHORD).unwrap().oriented);
    assert_eq!(face(&host, &[point]), Err(Unproven::Unattributed { entity: Some(13) }));
    // Beside an oriented triangle of the same kernel face it must lie on that face too.
    let base = tri([0., 0., 0.], [0., 1., 0.], [1., 0., 0.], [0., 0., -1.]);
    assert_eq!(face(&host, &[base, point]).map(|(_, f)| host[0].faces[f].role), Ok(Role::Cap { end: false }));
    let far = [[2., 1., 3.]; 3];
    assert_eq!(face(&host, &[base, far]), Err(Unproven::Ambiguous { entity: Some(13) }));
}

#[test]
fn m11_f_7955_kernel_face_without_a_common_source_face_refuses() {
    let host = [operand(&wall(&BOX, 3., [0.; 3]), false, 1., IDENTITY)];
    let top = tri([1., 0.5, 3.], [3., 0.5, 3.], [2., 1.5, 3.], [0., 0., 1.]);
    let side = tri([4., 0., 0.], [4., 2., 0.], [4., 0., 3.], [1., 0., 0.]);
    assert_eq!(face(&host, &[top, top]).map(|(_, f)| host[0].faces[f].role), Ok(Role::Cap { end: true }));
    // One revision-local face id across a cap and a side: the cross-check fails, nothing is guessed.
    assert_eq!(face(&host, &[top, side]), Err(Unproven::Ambiguous { entity: Some(13) }));
}

#[test]
fn m11_f_7955_swept_disk_wall_and_caps() {
    let text = std::fs::read_to_string("../geometry/tests/fixtures/swept_disk_trimmed_line.ifc").unwrap();
    let bar = [operand(&text, true, 1., IDENTITY)];
    // Hand-derived: r = 14.5 mm about the x axis from 0 to 2.75 m (millimetre file units).
    let wall = |degrees: f64, x: f64| { let t = degrees.to_radians(); [x, 0.0145 * t.cos(), 0.0145 * t.sin()] };
    assert_eq!(key(&bar, tri(wall(0., 0.), wall(5., 0.), wall(0., 2.75), [0., 1., 0.04])), Ok((43, "disk(wall)".into())));
    assert_eq!(key(&bar, tri([0., 0., 0.], wall(0., 0.), wall(5., 0.), [-1., 0., 0.])), Ok((43, "disk(start)".into())));
    assert_eq!(key(&bar, tri([2.75, 0., 0.], wall(0., 2.75), wall(5., 2.75), [1., 0., 0.])), Ok((43, "disk(end)".into())));
}

#[test]
fn m11_f_7955_rounding_skewed_sliver_carries_no_normal() {
    let host = [operand(&wall(&BOX, 3., [0.; 3]), false, 1., IDENTITY)];
    let top = tri([1., 0.5, 3.], [3., 0.5, 3.], [2., 1.5, 3.], [0., 0., 1.]);
    // A T-junction filler on the top cap: collinear up to a 1e-12 m rounding skew
    // out of the plane, so its facet normal points along -y instead of +z.
    let sliver = [[1., 1., 3.], [3., 1., 3.], [2., 1., 3. + 1e-12]];
    let list = candidates(&host, &sliver, CHORD).unwrap();
    assert!(!list.oriented, "area / longest² = 2.5e-13 is below faceDegenerateAreaRatio");
    assert_eq!(face(&host, &[top, sliver]).map(|(_, f)| host[0].faces[f].role), Ok(Role::Cap { end: true }));
}

#[test]
fn m11_f_7955_kind_ambiguity_is_decided_per_kernel_face() {
    let source = |role, support| SourceFace { role, support, extent: Extent::Wall };
    let lone = |item, faces| Operand { item, via: 0, from_part: IDENTITY, sign: 1., stretch: 1., faces, region: None , rows_identify_faces: false, request: None, subtracted: false };
    let operands = [lone(1, vec![source(Role::Cap { end: true }, Support::Plane { origin: [1., 0., 0.], normal: [1., 0., 0.] })]),
        lone(2, vec![source(Role::Side { boundary: 0, segment: 0 },
            Support::Cylinder { center: [0., 0.], radius: 1., generator: [0., 0., 1.], outward: 1. })])];
    // The tangent sliver alone lies on both; the rest of its kernel face only on the plane.
    let sliver = tri([1., -1e-4, 0.], [1., 1e-4, 0.], [1., 0., 1.], [1., 0., 0.]);
    assert_eq!(candidates(&operands, &sliver, CHORD).unwrap().matches.len(), 2);
    let plane = tri([1., 0.5, 0.], [1., 0.9, 0.], [1., 0.5, 1.], [1., 0., 0.]);
    assert_eq!(face(&operands, &[sliver, plane]), Ok((0, 0)));
}

#[test]
fn m11_f_7955_crossing_planes_on_a_thin_strip_refuse() {
    // A copy of the box tilted 3° about its top edge y = 0, z = 3: both top caps pass
    // incidence and the 5° normal test on a strip 10 µm wide along that edge.
    let (sin, cos) = 3f64.to_radians().sin_cos();
    let tilt = [1., 0., 0., 0., 0., cos, sin, 0., 0., -sin, cos, 0., 0., 3. * sin, 3. - 3. * cos, 1.];
    let mut tilted = operand(&wall(&BOX, 3., [0.; 3]), false, 1., tilt);
    tilted.item = 77;
    let operands = [operand(&wall(&BOX, 3., [0.; 3]), false, 1., IDENTITY), tilted];
    let strip = tri([1.75, 0., 3.], [2.25, 0., 3.], [2., 1e-5, 3.], [0., 0., 1.]);
    let list = candidates(&operands, &strip, CHORD).unwrap();
    assert_eq!(list.matches.iter().filter(|(_, held)| *held).count(), 2, "both bounded caps hold it: {list:?}");
    assert_eq!(face(&operands, &[strip]), Err(Unproven::Ambiguous { entity: Some(13) }), "never min() between crossing planes");
    // The same caps without the tilt are one surface: the left operand keeps it.
    let mut copy = operand(&wall(&BOX, 3., [0.; 3]), false, 1., IDENTITY);
    copy.item = 77;
    let flat = [operand(&wall(&BOX, 3., [0.; 3]), false, 1., IDENTITY), copy];
    assert_eq!(face(&flat, &[strip]).map(|(o, _)| flat[o].item), Ok(13));
}

#[test]
fn m11_f_7955_long_directrix_refuses_on_the_work_budget() {
    // 8192 cubic controls zig-zagging along x: every span passes x = 0.5 and no span
    // hull is farther from the wall than the curve, so each foot point samples all
    // 8189 spans. Default product budget: 10M work units.
    let points: Vec<[f64; 4]> = (0..8192).map(|i| [(i % 2) as f64, 0., 0., 1.]).collect();
    let mut knots = vec![0.; 4];
    knots.extend((1..8189).map(|i| i as f64));
    knots.extend([8189.; 4]);
    let curve = face_curve::Curve::new(3, points, knots, [0., 8189.]).unwrap();
    let tube = SourceFace { role: Role::DiskWall, extent: Extent::Wall, support: Support::Tube { curve, radius: 0.01 } };
    let bar = [Operand { item: 5, via: 0, from_part: IDENTITY, sign: 1., stretch: 1., faces: vec![tube], region: None , rows_identify_faces: false, request: None, subtracted: false }];
    let wall = tri([0.4, 0.01, 0.], [0.6, 0.01, 0.], [0.5, 0.01, 0.001], [0., 1., 0.]);
    let run = || {
        let account = resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(Default::default()));
        account.scope(|| {
            let budget = resource::ProductBudget::new(resource::BudgetStart::now(), 10_000_000, 1 << 30, 30_000);
            budget.scope(|| {
                for triangle in 0.. {
                    if let Err(halt) = candidates(&bar, &wall, CHORD) { return (triangle, halt); }
                }
                unreachable!()
            })
        })
    };
    let start = std::time::Instant::now();
    let (attributed, halt) = run();
    let elapsed = start.elapsed();
    let Halt::Stopped(ProgramStop::ResourceRefused(failure)) = halt else { panic!("{halt:?}") };
    assert_eq!(failure.dimension, Dimension::Work, "the work budget refuses, not the deadline");
    assert!(attributed <= 2, "{attributed} triangles before refusal");
    assert!(elapsed.as_secs_f64() < 10., "bounded wall time: {elapsed:?}");
    assert_eq!(run().0, attributed, "deterministic refusal point");
}
