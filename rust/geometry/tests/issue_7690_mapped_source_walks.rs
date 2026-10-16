// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7690: the mapped-source walks that bypass `process_representation_item`.
//!
//! - ROUTER-27: a raw national-grid item inside an `IfcRepresentationMap` must
//!   subtract the model RTC in f64 before f32 narrowing (#5698), on every walk:
//!   the merged element path (`mapped_item.rs`) and the type-geometry path
//!   (`textured.rs`), textured or not. The occurrence sub-mesh walk already
//!   did, and is checked here as the control.
//! - ROUTER-26: a capped B-spline edge (#4901) inside a type map is reported
//!   against that map, not against the next item on the thread.
//! - ROUTER-28: an opening carrying the same solid as `Body/Brep` and as
//!   `Body/MappedRepresentation` yields ONE cutter, as the mesh path meshes it.
//!
//! The shared-source (don't-bake) walk is covered by the crate-internal
//! `router::tests::mapped_walks_tests`.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{build_texture_index, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;

/// LV95 magnitude: one f32 ULP is 0.25 m here.
const SITE: [f64; 3] = [2_600_000.0, 1_200_000.0, 0.0];

/// A 12 x 7 x 5 mm box, relative to `SITE` (metres).
const FEATURE: [[f64; 3]; 8] = [
    [0.4, 0.3, 0.2],
    [0.412, 0.3, 0.2],
    [0.412, 0.307, 0.2],
    [0.4, 0.307, 0.2],
    [0.4, 0.3, 0.205],
    [0.412, 0.3, 0.205],
    [0.412, 0.307, 0.205],
    [0.4, 0.307, 0.205],
];
const FACES: [[usize; 4]; 6] =
    [[4, 3, 2, 1], [5, 6, 7, 8], [1, 2, 6, 5], [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8]];

#[derive(Clone, Copy, Debug)]
enum Shape {
    Triangulated,
    Polygonal,
    Brep,
}

/// One proxy (#1002) whose only body item is a mapped item (#1005) of map
/// #1003, whose source holds the raw-world `shape` (#900). Identity mapping;
/// the placement turns `degrees` about Z and the authored coordinates are the
/// inverse-turned world ones, so the placed feature lands at `SITE + FEATURE`.
fn fixture(shape: Shape, textured: bool, degrees: f64) -> String {
    let (cos, sin) = (degrees.to_radians().cos(), degrees.to_radians().sin());
    let mut s = format!(
        "#1=IFCCARTESIANPOINT((0.,0.,0.));#4=IFCDIRECTION(({cos:.15},{sin:.15},0.));\
         #2=IFCAXIS2PLACEMENT3D(#1,$,#4);#3=IFCLOCALPLACEMENT($,#2);#5=IFCAXIS2PLACEMENT3D(#1,$,$);"
    );
    let triple = |p: [f64; 3]| {
        let w = [p[0] + SITE[0], p[1] + SITE[1], p[2] + SITE[2]];
        format!("({:.6},{:.6},{:.6})", cos * w[0] + sin * w[1], cos * w[1] - sin * w[0], w[2])
    };
    for (i, p) in FEATURE.iter().enumerate() {
        s += &format!("#{}=IFCCARTESIANPOINT({});", i + 10, triple(*p));
    }
    for (i, face) in FACES.iter().enumerate() {
        let loop_refs = face.iter().map(|v| format!("#{}", v + 9)).collect::<Vec<_>>().join(",");
        s += &format!(
            "#{a}=IFCPOLYLOOP(({loop_refs}));#{b}=IFCFACEOUTERBOUND(#{a},.T.);#{c}=IFCFACE((#{b}));\
             #{d}=IFCINDEXEDPOLYGONALFACE(({idx}));",
            a = i + 200,
            b = i + 300,
            c = i + 400,
            d = i + 100,
            idx = face.map(|v| v.to_string()).join(","),
        );
    }
    let coords = FEATURE.iter().map(|p| triple(*p)).collect::<Vec<_>>().join(",");
    let triangles = FACES
        .iter()
        .flat_map(|f| [(f[0], f[1], f[2]), (f[0], f[2], f[3])])
        .map(|(a, b, c)| format!("({a},{b},{c})"))
        .collect::<Vec<_>>()
        .join(",");
    s += &format!("#700=IFCCARTESIANPOINTLIST3D(({coords}),$);");
    let (item, rep_type) = match shape {
        Shape::Triangulated => (format!("IFCTRIANGULATEDFACESET(#700,$,.T.,({triangles}),$)"), "Tessellation"),
        Shape::Polygonal => ("IFCPOLYGONALFACESET(#700,.T.,(#100,#101,#102,#103,#104,#105),$)".into(), "Tessellation"),
        Shape::Brep => ("IFCFACETEDBREP(#800)".into(), "Brep"),
    };
    s += &format!("#800=IFCCLOSEDSHELL((#400,#401,#402,#403,#404,#405));#900={item};");
    if textured {
        let uvs = (0..FEATURE.len()).map(|i| format!("({}.,{}.)", i % 2, (i / 2) % 2)).collect::<Vec<_>>();
        s += &format!(
            "#950=IFCIMAGETEXTURE(.T.,.T.,$,$,$,'feature.png');#951=IFCTEXTUREVERTEXLIST(({}));\
             #952=IFCINDEXEDTRIANGLETEXTUREMAP((#950),#900,#951,$);",
            uvs.join(",")
        );
    }
    s += &format!(
        "#1000=IFCSHAPEREPRESENTATION($,'Body','{rep_type}',(#900));#1003=IFCREPRESENTATIONMAP(#5,#1000);\
         #1004=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);#1005=IFCMAPPEDITEM(#1003,#1004);\
         #1006=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#1005));\
         #1001=IFCPRODUCTDEFINITIONSHAPE($,$,(#1006));\
         #1002=IFCBUILDINGELEMENTPROXY('0000000000000000000000',$,'Member',$,$,#3,#1001,$);"
    );
    s
}

fn rtc_router(framed: bool) -> GeometryRouter {
    let mut router = GeometryRouter::with_scale_and_local_frame(1.0, framed);
    router.set_rtc_offset((SITE[0], SITE[1], SITE[2]));
    router
}

/// Coordinate in the RTC frame. A type-geometry part has no placement step,
/// so one that was not rebased still holds the absolute coordinate.
fn rtc_frame(mesh: &Mesh, vertex: &[f32], axis: usize, placed: bool) -> f64 {
    let pending = if placed || mesh.rtc_applied { 0.0 } else { SITE[axis] };
    vertex[axis] as f64 + mesh.origin[axis] - pending
}

/// Every authored corner is present to `tolerance` (one f32 ULP at LV95 is 0.25 m).
fn assert_corners_within(meshes: &[&Mesh], placed: bool, tolerance: f64, label: &str) {
    for p in FEATURE {
        let found = meshes.iter().any(|mesh| {
            mesh.positions
                .chunks_exact(3)
                .any(|v| (0..3).all(|axis| (rtc_frame(mesh, v, axis, placed) - p[axis]).abs() < tolerance))
        });
        assert!(found, "{label}: authored corner {p:?} lost");
    }
}

fn assert_corners(meshes: &[&Mesh], placed: bool, label: &str) {
    assert_corners_within(meshes, placed, 1e-5, label);
}

/// ROUTER-27, merged path: `process_element` meshes the map through
/// `mapped_item.rs`, which called the processor directly and narrowed the raw
/// coordinates to f32 before the RTC subtraction. The sub-mesh walk is the control.
#[test]
fn router_27_raw_world_item_in_a_mapped_source_rebases_before_narrowing() {
    for shape in [Shape::Triangulated, Shape::Polygonal, Shape::Brep] {
        let source = fixture(shape, false, 0.0);
        for framed in [false, true] {
            let label = format!("{shape:?} framed={framed}");
            let mut decoder = EntityDecoder::new(&source);
            let element = decoder.decode_by_id(1002).unwrap();
            let parts = rtc_router(framed).process_element_parts(&element, &mut decoder).unwrap();
            assert_corners(&parts.iter().collect::<Vec<_>>(), true, &format!("{label} merged"));
            let subs = rtc_router(framed).process_element_with_submeshes(&element, &mut decoder).unwrap();
            let subs: Vec<&Mesh> = subs.sub_meshes.iter().map(|sub| &sub.mesh).collect();
            assert_corners(&subs, true, &format!("{label} sub-meshes (control)"));
        }
    }
}

/// ROUTER-27 under a turned placement. The source is rebased by the model RTC
/// in its own frame, so the offset must ride the mesh origin through the
/// placement rather than be treated as already subtracted: the sub-mesh walk
/// used to place this source 5 km off, and the merged walk lost the feature to
/// the 0.25 m grid. The residual is the source frame's distance from the RTC
/// (~5 km here), so the bound is that frame's f32 resolution, not 1e-5.
#[test]
fn router_27_rebased_mapped_source_survives_a_turned_placement() {
    let source = fixture(Shape::Triangulated, false, 0.1);
    for framed in [false, true] {
        let mut decoder = EntityDecoder::new(&source);
        let element = decoder.decode_by_id(1002).unwrap();
        let parts = rtc_router(framed).process_element_parts(&element, &mut decoder).unwrap();
        assert_corners_within(&parts.iter().collect::<Vec<_>>(), true, 1e-3, &format!("framed={framed} merged"));
        let subs = rtc_router(framed).process_element_with_submeshes(&element, &mut decoder).unwrap();
        let subs: Vec<&Mesh> = subs.sub_meshes.iter().map(|sub| &sub.mesh).collect();
        assert_corners_within(&subs, true, 1e-3, &format!("framed={framed} sub-meshes"));
    }
}

/// ROUTER-27, type-geometry path (`textured.rs`): plain and textured items of
/// an orphan type's map rebase before narrowing, and the textured face set
/// keeps its UVs.
#[test]
fn router_27_raw_world_items_in_a_type_map_rebase_before_narrowing() {
    for shape in [Shape::Triangulated, Shape::Brep] {
        let source = fixture(shape, false, 0.0);
        let mut decoder = EntityDecoder::new(&source);
        let rep_map = decoder.decode_by_id(1003).unwrap();
        let parts = rtc_router(false)
            .process_representation_map_with_texture(&rep_map, &mut decoder, &FxHashMap::default())
            .unwrap();
        assert_corners(&parts.iter().map(|(mesh, _, _)| mesh).collect::<Vec<_>>(), false, &format!("{shape:?} type map"));
    }

    let source = fixture(Shape::Triangulated, true, 0.0);
    let mut decoder = EntityDecoder::new(&source);
    let textures = build_texture_index(source.as_bytes(), &mut decoder);
    assert_eq!(textures.len(), 1, "fixture must declare one texture map");
    let rep_map = decoder.decode_by_id(1003).unwrap();
    let parts = rtc_router(false)
        .process_representation_map_with_texture(&rep_map, &mut decoder, &textures)
        .unwrap();
    assert_eq!(parts.len(), 1, "one textured part");
    let (mesh, uvs, texture) = &parts[0];
    assert!(texture.is_some(), "the textured part keeps its texture");
    assert_eq!(uvs.len() / 2, mesh.positions.len() / 3, "one UV per vertex");
    assert_corners(&[mesh], false, "textured type map");
}

/// A map whose single surface model has an advanced face bounded by a
/// B-spline edge of absurd degree, which the curve sampler caps (#4901); and an
/// unrelated plain extrusion (#109).
const CAPPED_CURVE_MAP: &str = r#"
#1=IFCCARTESIANPOINT((50.,0.,0.));#2=IFCCARTESIANPOINT((-50.,0.,0.));#3=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCCARTESIANPOINT((0.,60.,0.));#5=IFCVERTEXPOINT(#1);#6=IFCVERTEXPOINT(#2);
#9=IFCDIRECTION((0.,0.,1.));#10=IFCDIRECTION((1.,0.,0.));#11=IFCAXIS2PLACEMENT3D(#3,#9,#10);#12=IFCPLANE(#11);
#13=IFCBSPLINECURVEWITHKNOTS(999999,(#1,#4,#2),.UNSPECIFIED.,.F.,.F.,(3,3),(0.,1.));
#15=IFCLINE(#2,#20);#20=IFCVECTOR(#21,1.);#21=IFCDIRECTION((1.,0.,0.));
#30=IFCEDGECURVE(#5,#6,#13,.T.);#31=IFCEDGECURVE(#6,#5,#15,.T.);
#40=IFCORIENTEDEDGE(*,*,#30,.T.);#41=IFCORIENTEDEDGE(*,*,#31,.T.);#50=IFCEDGELOOP((#40,#41));
#51=IFCFACEOUTERBOUND(#50,.T.);#52=IFCADVANCEDFACE((#51),#12,.T.);#53=IFCOPENSHELL((#52));
#54=IFCSHELLBASEDSURFACEMODEL((#53));#55=IFCSHAPEREPRESENTATION($,'Body','SurfaceModel',(#54));
#60=IFCREPRESENTATIONMAP($,#55);
#100=IFCCARTESIANPOINT((0.,0.));#101=IFCAXIS2PLACEMENT2D(#100,$);
#102=IFCRECTANGLEPROFILEDEF(.AREA.,'P',#101,1000.,1000.);#103=IFCDIRECTION((0.,0.,1.));
#104=IFCCARTESIANPOINT((0.,0.,0.));#105=IFCAXIS2PLACEMENT3D(#104,$,$);
#106=IFCEXTRUDEDAREASOLID(#102,#105,#103,1000.);#107=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#106));
#108=IFCPRODUCTDEFINITIONSHAPE($,$,(#107));#109=IFCWALL('guid-plain',$,$,$,$,$,#108,$);
"#;

/// ROUTER-26, type-geometry path: the capped edge is reported for the map,
/// and the next, unrelated element does not inherit it.
#[test]
fn router_26_capped_curve_in_a_type_map_is_reported_for_that_map() {
    let mut decoder = EntityDecoder::new(CAPPED_CURVE_MAP);
    let router = GeometryRouter::new();
    let rep_map = decoder.decode_by_id(60).unwrap();
    let _ = router.process_representation_map(&rep_map, &mut decoder);
    let after_map = router.take_unsupported_items();
    assert_eq!(after_map.get("IfcBSplineCurveWithKnots"), Some(&1), "{after_map:?}");

    let plain = decoder.decode_by_id(109).unwrap();
    router.process_element(&plain, &mut decoder).expect("the plain wall meshes");
    let after_plain = router.take_unsupported_items();
    assert!(after_plain.is_empty(), "the plain wall inherited a drop: {after_plain:?}");
}

/// An opening (#40) carrying one 0.4 m prism twice: as `Body/SweptSolid`
/// (#33) and as `Body/MappedRepresentation` (#38 mapping the same solid).
const DUPLICATED_OPENING: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
    #3=IFCLOCALPLACEMENT($,#2);#4=IFCDIRECTION((0.,0.,1.));\
    #30=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,0.4,0.4);#31=IFCCARTESIANPOINT((0.,0.,-1.));\
    #32=IFCAXIS2PLACEMENT3D(#31,$,$);#33=IFCEXTRUDEDAREASOLID(#30,#32,#4,3.);\
    #34=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#33));\
    #36=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#33));#37=IFCREPRESENTATIONMAP(#2,#36);\
    #15=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);#38=IFCMAPPEDITEM(#37,#15);\
    #39=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#38));\
    #35=IFCPRODUCTDEFINITIONSHAPE($,$,(#34,#39));\
    #40=IFCOPENINGELEMENT('0000000000000000000001',$,'Opening',$,$,#3,#35,$,.OPENING.);";

/// ROUTER-28: both opening probes select representations like the mesh path,
/// so the duplicated solid is one cutter, not two.
#[test]
fn router_28_opening_probes_skip_a_mapped_duplicate_of_direct_body_geometry() {
    let mut decoder = EntityDecoder::new(DUPLICATED_OPENING);
    let opening = decoder.decode_by_id(40).unwrap();
    let router = GeometryRouter::new();
    let meshes = router.get_opening_item_meshes_world(&opening, &mut decoder).unwrap();
    assert_eq!(meshes.len(), 1, "one cutter mesh for one void");
    let bounds = router.get_opening_item_bounds_with_direction(&opening, &mut decoder).unwrap();
    assert_eq!(bounds.len(), 1, "one cutter box for one void");
    let (min, max, direction) = &bounds[0];
    assert!((max.x - min.x - 0.4).abs() < 1e-6 && (max.z - min.z - 3.0).abs() < 1e-6, "{min:?}..{max:?}");
    assert!(direction.is_some_and(|d| (d.z - 1.0).abs() < 1e-9), "{direction:?}");
}
