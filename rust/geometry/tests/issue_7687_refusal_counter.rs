// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7687 round 2 (adversarial review of #7745): every face the curve and loop
//! readers refuse is COUNTED (D3, fail closed plus a counter). Before this a
//! refused face was dropped by the brep's per-face skip (#5053) and nothing
//! reached `take_unsupported_items`. Also pins three refusals that still
//! failed open: a refused revolution profile drawn as a flat face, and a
//! dangling `EdgeGeometry` or trimmed `BasisCurve` drawn as a chord.
//!
//! The cube fixture is the reviewer's attack model: an `IfcAdvancedBrep` of
//! six planar faces, each an edge loop of four polyline edges, 12 triangles.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::{GeometryRouter, Mesh};

fn wrap(data: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\n\
         FILE_SCHEMA(('IFC4X3_ADD2'));\nENDSEC;\nDATA;\n{data}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// Process entity #1 through the public router: the triangle count (0 for
/// an `Err`) and the unsupported-item counts recorded for it.
fn process(data: &str) -> (usize, Vec<(String, u64)>) {
    let content = wrap(data);
    let index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, index);
    let router = GeometryRouter::new();
    let entity = decoder.decode_by_id(1).expect("decode");
    let tris = router
        .process_representation_item(&entity, &mut decoder)
        .map_or(0, |mesh: Mesh| mesh.indices.len() / 3);
    let mut counted: Vec<(String, u64)> = router.take_unsupported_items().into_iter().collect();
    counted.sort();
    (tris, counted)
}

fn counts_refused_face(counted: &[(String, u64)]) -> bool {
    counted.iter().any(|(name, n)| name == "IfcAdvancedFace" && *n > 0)
}

/// The unit cube, with `patch` (exact line rewrites) applied.
fn cube(patch: &[(&str, &str)]) -> String {
    let mut s = String::from("#1=IFCADVANCEDBREP(#2);\n#2=IFCCLOSEDSHELL((#101,#102,#103,#104,#105,#106));\n");
    let v = [
        (0., 0., 0.), (1., 0., 0.), (1., 1., 0.), (0., 1., 0.),
        (0., 0., 1.), (1., 0., 1.), (1., 1., 1.), (0., 1., 1.),
    ];
    for (i, (x, y, z)) in v.iter().enumerate() {
        s.push_str(&format!("#{}=IFCCARTESIANPOINT(({x:.1},{y:.1},{z:.1}));\n", 10 + i));
        s.push_str(&format!("#{}=IFCVERTEXPOINT(#{});\n", 20 + i, 10 + i));
    }
    let faces: [[usize; 4]; 6] =
        [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    let planes = [
        ("(0.,0.,0.)", "(0.,0.,-1.)"), ("(0.,0.,1.)", "(0.,0.,1.)"), ("(0.,0.,0.)", "(0.,-1.,0.)"),
        ("(1.,0.,0.)", "(1.,0.,0.)"), ("(0.,1.,0.)", "(0.,1.,0.)"), ("(0.,0.,0.)", "(-1.,0.,0.)"),
    ];
    let mut id = 1000;
    for (fi, f) in faces.iter().enumerate() {
        let (face, bound, lp, plane) = (101 + fi, 200 + fi, 300 + fi, 400 + fi);
        let mut edges = Vec::new();
        for k in 0..4 {
            let (a, b) = (f[k], f[(k + 1) % 4]);
            let (line, ec, oe) = (id, id + 1, id + 2);
            id += 3;
            s.push_str(&format!("#{line}=IFCPOLYLINE((#{},#{}));\n", 10 + a, 10 + b));
            s.push_str(&format!("#{ec}=IFCEDGECURVE(#{},#{},#{line},.T.);\n", 20 + a, 20 + b));
            s.push_str(&format!("#{oe}=IFCORIENTEDEDGE(*,*,#{ec},.T.);\n"));
            edges.push(format!("#{oe}"));
        }
        s.push_str(&format!("#{lp}=IFCEDGELOOP(({}));\n#{bound}=IFCFACEOUTERBOUND(#{lp},.T.);\n", edges.join(",")));
        s.push_str(&format!(
            "#{face}=IFCADVANCEDFACE((#{bound}),#{plane},.T.);\n#{plane}=IFCPLANE(#{p});\n\
             #{p}=IFCAXIS2PLACEMENT3D(#{o},#{n},$);\n#{o}=IFCCARTESIANPOINT({});\n#{n}=IFCDIRECTION({});\n",
            planes[fi].0, planes[fi].1, p = plane + 100, o = plane + 200, n = plane + 300,
        ));
    }
    for (from, to) in patch {
        assert!(s.contains(from), "patch target {from} missing");
        s = s.replace(from, to);
    }
    s
}

/// Control: all six faces mesh and nothing is counted.
#[test]
fn cube_control_meshes_uncounted_7687() {
    assert_eq!(process(&cube(&[])), (12, vec![]));
}

/// A dangling `EdgeElement` refuses face #101 only (#5053 keeps the other
/// five) and is counted.
#[test]
fn dangling_edge_element_refuses_one_face_counted_7687() {
    let (tris, counted) = process(&cube(&[(
        "#1002=IFCORIENTEDEDGE(*,*,#1001,.T.);",
        "#1002=IFCORIENTEDEDGE(*,*,#9999,.T.);",
    )]));
    assert_eq!(tris, 10);
    assert!(counts_refused_face(&counted), "the refused face must be counted, got {counted:?}");
}

/// #7688 PROC-S25: a face reference that does not resolve at all (not even to
/// a record) used to abort the whole solid with `Err`, deleting the element.
/// It is one refused face like any other: the other five mesh, and it is
/// counted.
#[test]
fn dangling_face_reference_refuses_one_face_not_the_solid_7688() {
    let (tris, counted) = process(&cube(&[(
        "#2=IFCCLOSEDSHELL((#101,#102,#103,#104,#105,#106));",
        "#2=IFCCLOSEDSHELL((#101,#102,#103,#104,#105,#9999));",
    )]));
    assert_eq!(tris, 10, "five of six faces must still mesh");
    assert!(counts_refused_face(&counted), "the refused face must be counted, got {counted:?}");
}

/// A dangling vertex is shared by three faces: all three are refused.
#[test]
fn dangling_vertex_refuses_its_three_faces_counted_7687() {
    let (tris, counted) = process(&cube(&[("#20=IFCVERTEXPOINT(#10);", "#20=IFCVERTEXPOINT(#9999);")]));
    assert_eq!(tris, 6);
    assert!(counts_refused_face(&counted), "got {counted:?}");
}

/// A polyline edge whose point dangles refuses the two faces sharing it.
#[test]
fn dangling_polyline_point_is_counted_7687() {
    let (tris, counted) =
        process(&cube(&[("#1000=IFCPOLYLINE((#10,#13));", "#1000=IFCPOLYLINE((#10,#9999));")]));
    assert_eq!(tris, 10);
    assert!(counts_refused_face(&counted), "got {counted:?}");
}

/// Every vertex dangling: the element meshes nothing, which must be visible.
#[test]
fn all_faces_refused_is_counted_7687() {
    let froms: Vec<String> = (0..8).map(|i| format!("#{}=IFCVERTEXPOINT(#{});", 20 + i, 10 + i)).collect();
    let tos: Vec<String> = (0..8).map(|i| format!("#{}=IFCVERTEXPOINT(#9999);", 20 + i)).collect();
    let patch: Vec<(&str, &str)> = froms.iter().zip(&tos).map(|(a, b)| (a.as_str(), b.as_str())).collect();
    let (tris, counted) = process(&cube(&patch));
    assert_eq!(tris, 0);
    assert!(counts_refused_face(&counted), "got {counted:?}");
}

/// A present but dangling `EdgeGeometry` was drawn as the straight chord.
#[test]
fn dangling_edge_geometry_is_refused_not_a_chord_7687() {
    let (tris, counted) = process(&cube(&[(
        "#1001=IFCEDGECURVE(#20,#23,#1000,.T.);",
        "#1001=IFCEDGECURVE(#20,#23,#9999,.T.);",
    )]));
    assert_eq!(tris, 10, "both faces on the edge must be refused");
    assert!(counts_refused_face(&counted), "got {counted:?}");
}

/// A trimmed curve whose `BasisCurve` dangles was drawn as the chord too.
#[test]
fn dangling_trimmed_basis_curve_is_refused_not_a_chord_7687() {
    let (tris, counted) = process(&cube(&[(
        "#1000=IFCPOLYLINE((#10,#13));",
        "#1000=IFCTRIMMEDCURVE(#9999,(#10),(#13),.T.,.CARTESIAN.);",
    )]));
    assert_eq!(tris, 10, "both faces on the edge must be refused");
    assert!(counts_refused_face(&counted), "got {counted:?}");
}

/// A surface of revolution about Z on the unit cylinder, with a REAL quarter
/// boundary (four polyline edges), so the planar fallback has a polygon to
/// draw; `profile` is curve #15.
fn revolved_quarter(profile: &str) -> String {
    format!(
        "#1=IFCADVANCEDBREP(#2);\n#2=IFCCLOSEDSHELL((#3));\n#3=IFCADVANCEDFACE((#4),#10,.T.);\n\
         #4=IFCFACEOUTERBOUND(#5,.T.);\n#5=IFCEDGELOOP((#61,#62,#63,#64));\n\
         #10=IFCSURFACEOFREVOLUTION(#13,$,#11);\n#11=IFCAXIS1PLACEMENT(#12,#14);\n\
         #12=IFCCARTESIANPOINT((0.,0.,0.));\n#14=IFCDIRECTION((0.,0.,1.));\n\
         #13=IFCARBITRARYOPENPROFILEDEF(.CURVE.,$,#15);\n{profile}\
         #16=IFCCARTESIANPOINT((1.,0.,0.));\n#17=IFCCARTESIANPOINT((1.,0.,1.));\n\
         #21=IFCCARTESIANPOINT((1.,0.,0.));\n#22=IFCCARTESIANPOINT((0.,1.,0.));\n\
         #23=IFCCARTESIANPOINT((0.,1.,1.));\n#24=IFCCARTESIANPOINT((1.,0.,1.));\n\
         #31=IFCVERTEXPOINT(#21);\n#32=IFCVERTEXPOINT(#22);\n#33=IFCVERTEXPOINT(#23);\n#34=IFCVERTEXPOINT(#24);\n\
         #41=IFCPOLYLINE((#21,#22));\n#42=IFCPOLYLINE((#22,#23));\n#43=IFCPOLYLINE((#23,#24));\n#44=IFCPOLYLINE((#24,#21));\n\
         #51=IFCEDGECURVE(#31,#32,#41,.T.);\n#52=IFCEDGECURVE(#32,#33,#42,.T.);\n\
         #53=IFCEDGECURVE(#33,#34,#43,.T.);\n#54=IFCEDGECURVE(#34,#31,#44,.T.);\n\
         #61=IFCORIENTEDEDGE(*,*,#51,.T.);\n#62=IFCORIENTEDEDGE(*,*,#52,.T.);\n\
         #63=IFCORIENTEDEDGE(*,*,#53,.T.);\n#64=IFCORIENTEDEDGE(*,*,#54,.T.);\n"
    )
}

/// Control: the readable profile revolves (more than the 2-triangle chord quad).
#[test]
fn revolved_quarter_control_revolves_7687() {
    let (tris, counted) = process(&revolved_quarter("#15=IFCPOLYLINE((#16,#17));\n"));
    assert!(tris > 2, "the quarter cylinder must be revolved, got {tris} triangles");
    assert_eq!(counted, vec![]);
}

/// A refused profile fell into the planar fallback and drew the boundary's
/// flat chord quad (2 triangles) in place of the curved surface.
#[test]
fn refused_revolution_profile_is_not_a_flat_face_7687() {
    for profile in [
        "#15=IFCPOLYLINE((#16,#99,#17));\n",
        "#15=IFCBSPLINECURVEWITHKNOTS(1,(#16,#99,#17),.UNSPECIFIED.,.F.,.F.,(2,1,2),(0.,0.5,1.),.UNSPECIFIED.);\n",
    ] {
        let (tris, counted) = process(&revolved_quarter(profile));
        assert_eq!(tris, 0, "{profile}: a refused profile must refuse the face");
        assert!(counts_refused_face(&counted), "{profile}: got {counted:?}");
    }
}

/// A single-face brep on a degree-1 rational B-spline surface (2x2 grid)
/// whose WeightsData is `weights`, as written.
fn rational_face(weights: &str) -> String {
    format!(
        "#1=IFCADVANCEDBREP(#2);\n#2=IFCCLOSEDSHELL((#3));\n#3=IFCADVANCEDFACE((#4),#10,.T.);\n\
         #4=IFCFACEOUTERBOUND(#5,.T.);\n#5=IFCEDGELOOP(());\n\
         #10=IFCRATIONALBSPLINESURFACEWITHKNOTS(1,1,((#11,#12),(#13,#14)),.UNSPECIFIED.,.F.,.F.,.F.,\
         (2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.,{weights});\n\
         #11=IFCCARTESIANPOINT((0.,0.,0.));\n#12=IFCCARTESIANPOINT((0.,1.,0.));\n\
         #13=IFCCARTESIANPOINT((1.,0.,0.));\n#14=IFCCARTESIANPOINT((1.,1.,0.));\n"
    )
}

#[test]
fn rational_surface_control_meshes_7687() {
    let (tris, counted) = process(&rational_face("((1.,2.),(1.,1.))"));
    assert!(tris > 0);
    assert_eq!(counted, vec![]);
}

/// WeightsData is mandatory and positive, one weight per control point. A
/// short row shifted every later weight onto the wrong point; a missing or
/// non-positive one was evaluated as if unweighted or degenerate.
#[test]
fn malformed_rational_weights_refuse_the_surface_7687() {
    for weights in ["((1.,2.),(1.))", "((1.,$),(1.,1.))", "((1.,0.),(1.,1.))", "((1.,-2.),(1.,1.))", "((1.,2.))", "$"] {
        let (tris, counted) = process(&rational_face(weights));
        assert_eq!(tris, 0, "weights {weights} must refuse the surface");
        assert!(counts_refused_face(&counted), "weights {weights}: got {counted:?}");
    }
}

/// A non-numeric knot or multiplicity was dropped, shifting the knot vector.
#[test]
fn non_numeric_surface_knot_refuses_the_surface_7687() {
    for (from, to) in [("(0.,1.),(0.,1.)", "(0.,$),(0.,1.)"), ("(2,2),(2,2)", "(2,$),(2,2)")] {
        let data = rational_face("((1.,2.),(1.,1.))").replace(from, to);
        let (tris, counted) = process(&data);
        assert_eq!(tris, 0, "{to} must refuse the surface");
        assert!(counts_refused_face(&counted), "{to}: got {counted:?}");
    }
}

/// The same for a B-spline edge curve's knot list.
#[test]
fn non_numeric_curve_knot_refuses_the_face_7687() {
    let (tris, counted) = process(&cube(&[(
        "#1000=IFCPOLYLINE((#10,#13));",
        "#1000=IFCBSPLINECURVEWITHKNOTS(1,(#10,#13),.UNSPECIFIED.,.F.,.F.,(2,2),(0.,$),.UNSPECIFIED.);",
    )]));
    assert_eq!(tris, 10, "both faces on the edge must be refused");
    assert!(counts_refused_face(&counted), "got {counted:?}");
}

/// Run the PUBLIC `AdvancedBrepProcessor` on `data` directly, outside the
/// router, so nothing drains the thread-local refusal flags afterwards.
fn direct_processor_call(data: &str) {
    use ifc_lite_core::IfcSchema;
    use ifc_lite_geometry::{AdvancedBrepProcessor, GeometryProcessor, TessellationQuality};
    let content = wrap(data);
    let index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, index);
    let entity = decoder.decode_by_id(1).expect("decode");
    let _ = AdvancedBrepProcessor::new().process(
        &entity,
        &mut decoder,
        &IfcSchema::new(),
        TessellationQuality::Medium,
    );
}

/// Stale-flag hazard (#7745 review): a direct processor call that refuses a
/// face leaves the face-refused flag set on the thread; the next router item
/// must not inherit it. `process_item_in_rtc_frame` resets the flags first.
#[test]
fn direct_processor_refusal_does_not_leak_into_the_next_router_item_7687() {
    direct_processor_call(&cube(&[(
        "#1002=IFCORIENTEDEDGE(*,*,#1001,.T.);",
        "#1002=IFCORIENTEDEDGE(*,*,#9999,.T.);",
    )]));
    assert_eq!(process(&cube(&[])), (12, vec![]), "the intact cube must record nothing");
}

/// The same for the capped-curve flag (`bspline_budget::CURVE_CAPPED`).
#[test]
fn direct_processor_capped_curve_does_not_leak_into_the_next_router_item_7687() {
    direct_processor_call(&cube(&[(
        "#1000=IFCPOLYLINE((#10,#13));",
        "#1000=IFCBSPLINECURVEWITHKNOTS(999999,(#10,#13,#13),.UNSPECIFIED.,.F.,.F.,(3,3),(0.,1.),.UNSPECIFIED.);",
    )]));
    assert_eq!(process(&cube(&[])), (12, vec![]), "the intact cube must record nothing");
}

/// The refused face is counted under its REAL type (#7787 audit): a faceted
/// brep's `IfcFace` is not an `IfcAdvancedFace`.
#[test]
fn refused_faceted_brep_face_is_counted_as_ifc_face() {
    let (tris, counted) = process(
        "#1=IFCFACETEDBREP(#2);\n#2=IFCCLOSEDSHELL((#20));\n\
         #3=IFCCARTESIANPOINT((0.,0.,0.));#4=IFCCARTESIANPOINT((1.,0.,0.));#5=IFCCARTESIANPOINT((0.,1.,0.));\n\
         #10=IFCPOLYLOOP((#3,#4,#5));#11=IFCFACEOUTERBOUND(#10,.T.);\n\
         #12=IFCPOLYLOOP((#3,#9999,#5));#13=IFCFACEBOUND(#12,.T.);\n\
         #20=IFCFACE((#11,#13));\n",
    );
    assert_eq!(tris, 0);
    assert_eq!(counted, vec![("IfcFace".to_string(), 1)], "got {counted:?}");
}

/// A polygonal face with a dangling corner (past the end of the point list)
/// is dropped whole AND counted under its own type (D3); it used to vanish
/// silently. The intact face beside it still meshes.
#[test]
fn dangling_polygonal_face_corner_is_counted_7687() {
    let face_set = |bad: &str| {
        format!(
            "#1=IFCPOLYGONALFACESET(#2,.F.,(#3,#4),$);\n\
             #2=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(1.,1.,0.),(0.,1.,0.)),$);\n\
             #3=IFCINDEXEDPOLYGONALFACE((1,2,3));\n#4=IFCINDEXEDPOLYGONALFACE((1,3,{bad}));\n"
        )
    };
    assert_eq!(process(&face_set("4")), (2, vec![]), "the intact face set records nothing");
    assert_eq!(
        process(&face_set("9")),
        (1, vec![("IfcIndexedPolygonalFace".to_string(), 1)]),
    );
}
