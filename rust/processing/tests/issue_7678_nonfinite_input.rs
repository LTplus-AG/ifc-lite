// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7678 (S6a): non-finite input is refused where STEP is decoded, not
//! admitted into geometry.
//!
//! STEP has no NaN or infinity spelling, so a non-finite number can only enter
//! as a literal its type cannot hold: `1.E400` overflows `f64`, `1.E39` the
//! `f32` the coordinate-list fast path reads. Before the fix those decoded to
//! infinities and every geometry reader had to catch them on its own; the ones
//! that did not (an extrusion depth, a profile dimension, a placement) emitted
//! NaN/inf vertices or relied on a late finiteness filter. Now the decode
//! boundary refuses the record, so each element below fails closed on its own
//! while its well-formed neighbour meshes exactly as it does alone.

use ifc_lite_processing::process_geometry;

const HEAD: &str = "ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-7678 non-finite input'),'2;1');
FILE_NAME('t.ifc','2026-10-16T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((1.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);
#5=IFCCARTESIANPOINT((0.,0.));
#6=IFCAXIS2PLACEMENT2D(#5,$);
#16=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#17=IFCUNITASSIGNMENT((#16));
#19=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#4,$);
#20=IFCPROJECT('1Project00000000007678',$,'P',$,$,$,$,(#19),#17);
#21=IFCLOCALPLACEMENT($,#4);
";

const TAIL: &str = "ENDSEC;
END-ISO-10303-21;
";

/// A wall extruded from a rectangle profile, each piece spelled by the caller
/// so one literal per case can overflow. `id` keeps the records apart.
fn wall(id: u32, x_dim: &str, depth: &str, direction: &str, location: &str) -> String {
    let i = |k: u32| id + k;
    format!(
        "#{p}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#6,{x_dim},0.2);
#{d}=IFCDIRECTION(({direction}));
#{s}=IFCEXTRUDEDAREASOLID(#{p},#4,#{d},{depth});
#{r}=IFCSHAPEREPRESENTATION(#19,'Body','SweptSolid',(#{s}));
#{ps}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{r}));
#{pt}=IFCCARTESIANPOINT(({location}));
#{ax}=IFCAXIS2PLACEMENT3D(#{pt},$,$);
#{lp}=IFCLOCALPLACEMENT(#21,#{ax});
#{id}=IFCWALL('2Wall0000000000000{id}',$,'W{id}',$,$,#{lp},#{ps},$,$);
",
        p = i(1),
        d = i(2),
        s = i(3),
        r = i(4),
        ps = i(5),
        pt = i(6),
        ax = i(7),
        lp = i(8),
    )
}

fn good(id: u32) -> String {
    wall(id, "4.", "3.", "0.,0.,1.", "1.,2.,0.")
}

/// A triangulated face set whose point list holds `coordinate`: the f32
/// coordinate-list fast path, not the tokenizer, reads this one.
fn face_set(id: u32, coordinate: &str) -> String {
    format!(
        "#{l}=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),({coordinate},1.,0.)));
#{f}=IFCTRIANGULATEDFACESET(#{l},$,$,((1,2,3)),$);
#{r}=IFCSHAPEREPRESENTATION(#19,'Body','Tessellation',(#{f}));
#{ps}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{r}));
#{id}=IFCBUILDINGELEMENTPROXY('3Proxy000000000000{id}',$,'P{id}',$,$,#21,#{ps},$,$);
",
        l = id + 1,
        f = id + 2,
        r = id + 3,
        ps = id + 4,
    )
}

/// A closed unit-cube `IfcFacetedBrep` whose vertex #8 has `z` spelled by the
/// caller, so one overflowing literal can sit in one corner (#7678 review).
fn cube(id: u32, z7: &str) -> String {
    let corner = ["0.,0.,0.", "1.,0.,0.", "1.,1.,0.", "0.,1.,0.", "0.,0.,1.", "1.,0.,1.", "1.,1.,1."];
    let mut s = String::new();
    for (k, c) in corner.iter().enumerate() {
        s.push_str(&format!("#{}=IFCCARTESIANPOINT(({c}));\n", id + 1 + k as u32));
    }
    s.push_str(&format!("#{}=IFCCARTESIANPOINT((0.,1.,{z7}));\n", id + 8));
    let faces = [[1, 4, 3, 2], [5, 6, 7, 8], [1, 2, 6, 5], [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8]];
    let mut face_ids = Vec::new();
    for (k, f) in faces.iter().enumerate() {
        let (l, b, fc) = (id + 10 + 3 * k as u32, id + 11 + 3 * k as u32, id + 12 + 3 * k as u32);
        let pts: Vec<String> = f.iter().map(|v| format!("#{}", id + v)).collect();
        s.push_str(&format!("#{l}=IFCPOLYLOOP(({}));\n#{b}=IFCFACEOUTERBOUND(#{l},.T.);\n#{fc}=IFCFACE((#{b}));\n", pts.join(",")));
        face_ids.push(format!("#{fc}"));
    }
    let (sh, br, r, ps) = (id + 40, id + 41, id + 42, id + 43);
    s.push_str(&format!(
        "#{sh}=IFCCLOSEDSHELL(({}));\n#{br}=IFCFACETEDBREP(#{sh});\n\
         #{r}=IFCSHAPEREPRESENTATION(#19,'Body','Brep',(#{br}));\n#{ps}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{r}));\n\
         #{id}=IFCBUILDINGELEMENTPROXY('4Cube0000000000000{id}',$,'C',$,$,#21,#{ps},$,$);\n",
        face_ids.join(",")
    ));
    s
}

/// A door: [`wall`]'s body under an `IfcDoor` whose OverallHeight is spelled
/// by the caller. The product record's own reals are descriptive, not geometry.
fn door(id: u32, overall_height: &str) -> String {
    wall(id, "4.", "3.", "0.,0.,1.", "1.,2.,0.").replace(
        &format!("#{id}=IFCWALL('2Wall0000000000000{id}',$,'W{id}',$,$,#{lp},#{ps},$,$);", lp = id + 8, ps = id + 5),
        &format!("#{id}=IFCDOOR('2Door0000000000000{id}',$,'D{id}',$,$,#{lp},#{ps},$,{overall_height},0.9,$,$,$);", lp = id + 8, ps = id + 5),
    )
}

/// A far-away point list (5e6 m) that turns the RTC rebase on for the model.
fn far_face_set(id: u32) -> String {
    face_set(id, "5000001.").replace("((0.,0.,0.),(1.,0.,0.),", "((5000000.,5000000.,0.),(5000001.,5000000.,0.),").replace(",1.,0.)));", ",5000001.,0.)));")
}

fn file(body: &str) -> String {
    format!("{HEAD}{body}{TAIL}")
}

/// Each case, and how many elements D3's refused-element counter counts. Every
/// family is counted, including the coordinate-list fast path and a faceted
/// brep whose one overflowing vertex used to open the shell into a finite
/// half cube (#7678 review, findings 2 and 3).
fn poisoned_cases() -> Vec<(&'static str, String, u64)> {
    vec![
        ("extrusion Depth 1.E400", wall(200, "4.", "1.E400", "0.,0.,1.", "1.,2.,0."), 1),
        ("extrusion Depth -1.E400", wall(250, "4.", "-1.E400", "0.,0.,1.", "1.,2.,0."), 1),
        ("profile XDim 1.E400", wall(300, "1.E400", "3.", "0.,0.,1.", "1.,2.,0."), 1),
        ("ExtrudedDirection 1.E400", wall(400, "4.", "3.", "0.,0.,1.E400", "1.,2.,0."), 1),
        ("placement Location 1.E400", wall(500, "4.", "3.", "0.,0.,1.", "1.E400,2.,0."), 1),
        ("f32 point list 1.E39", face_set(600, "1.E39"), 1),
        ("point list 1.E400", face_set(700, "1.E400"), 1),
        ("faceted cube vertex 1.E400", cube(800, "1.E400"), 1),
    ]
}

/// Every poisoned element is refused: no mesh, so no NaN or infinite vertex,
/// and D3's refused-element counter says so. The well-formed wall beside them
/// is byte-identical to the wall alone.
#[test]
fn an_overflowing_literal_refuses_its_element_and_spares_its_neighbour() {
    let alone = process_geometry(&file(&good(100)));
    let reference: Vec<_> = alone.meshes.iter().filter(|m| m.express_id == 100).collect();
    assert_eq!(reference.len(), 1, "anti-vacuity: the good wall meshes alone");
    assert!(!reference[0].positions.is_empty());

    assert_eq!(alone.stats.refused_input_elements, 0, "a clean file refuses nothing");
    for (case, body, counted) in poisoned_cases() {
        let result = process_geometry(&file(&format!("{}{body}", good(100))));
        for mesh in &result.meshes {
            assert!(
                mesh.positions.iter().all(|v| v.is_finite()),
                "{case}: #{} carries a non-finite vertex",
                mesh.express_id
            );
            assert_eq!(mesh.express_id, 100, "{case}: #{} was not refused", mesh.express_id);
        }
        assert_eq!(result.stats.refused_input_elements, counted, "{case}: refused-element counter");
        let kept: Vec<_> = result.meshes.iter().filter(|m| m.express_id == 100).collect();
        assert_eq!(kept.len(), 1, "{case}");
        assert_eq!(kept[0].positions, reference[0].positions, "{case}: neighbour moved");
        assert_eq!(kept[0].indices, reference[0].indices, "{case}: neighbour moved");
    }
}

/// The finite spellings the boundary must keep: `-0.` everywhere a poisoned
/// case put an overflow, a large finite f32 coordinate, and an
/// underflowing literal that rounds to zero. Each still meshes, finitely.
#[test]
fn negative_zero_underflow_and_large_finite_literals_still_mesh() {
    for (case, body, id) in [
        ("-0. location and direction", wall(200, "4.", "3.", "-0.,-0.,1.", "-0.,-0.,-0."), 200),
        ("underflowing depth part", wall(300, "4.", "3.000000000000000000001", "0.,1.E-400,1.", "1.E-400,0.,0."), 300),
        ("large finite f32 point", face_set(600, "1.E30"), 600),
    ] {
        let result = process_geometry(&file(&body));
        let mesh = result
            .meshes
            .iter()
            .find(|m| m.express_id == id)
            .unwrap_or_else(|| panic!("{case}: refused, ids {:?}", result.meshes.iter().map(|m| m.express_id).collect::<Vec<_>>()));
        assert!(!mesh.positions.is_empty(), "{case}");
        assert!(mesh.positions.iter().all(|v| v.is_finite()), "{case}");
    }
}

/// #7678 review finding 3: the same `1.E39` point list gives the same outcome
/// with and without RTC. With RTC active (three elements 5e6 m away) the f64
/// branch used to subtract the offset and narrow `1.E39` to an `f32`
/// infinity; it is now refused and counted like the non-RTC f32 read.
#[test]
fn an_overflowing_point_list_is_refused_the_same_with_rtc() {
    for (case, coordinate) in [("f32 overflow 1.E39", "1.E39"), ("f64 overflow 1.E400", "1.E400")] {
        let far = format!("{}{}{}", far_face_set(900), far_face_set(950), far_face_set(980));
        let result = process_geometry(&file(&format!("{far}{}", face_set(600, coordinate))));
        let ids: Vec<u32> = result.meshes.iter().map(|m| m.express_id).collect();
        assert!(ids.contains(&900), "{case}: anti-vacuity, the far element meshes: {ids:?}");
        let shift = result.metadata.coordinate_info.origin_shift;
        assert!(shift.iter().any(|v| *v != 0.0), "{case}: anti-vacuity, RTC is active: {shift:?}");
        assert!(!ids.contains(&600), "{case}: the poisoned list must be refused under RTC: {ids:?}");
        assert!(result.meshes.iter().all(|m| m.positions.iter().all(|v| v.is_finite())), "{case}");
        assert_eq!(result.stats.refused_input_elements, 1, "{case}");
    }
}

/// #7678 review finding 4: a product record that holds an overflowing value
/// nothing draws (a door's OverallHeight) keeps its finite mesh, byte-identical
/// to the same door with a finite height, and nothing is counted.
#[test]
fn an_overflowing_descriptive_real_on_the_product_keeps_its_mesh() {
    let finite = process_geometry(&file(&door(200, "2.1")));
    let overflow = process_geometry(&file(&door(200, "1.E400")));
    let mesh = |r: &ifc_lite_processing::ProcessingResult| {
        r.meshes.iter().find(|m| m.express_id == 200).map(|m| (m.positions.clone(), m.indices.clone()))
    };
    assert!(mesh(&finite).is_some_and(|(p, _)| !p.is_empty()), "anti-vacuity: the door meshes");
    assert_eq!(mesh(&overflow), mesh(&finite), "the door's mesh must not depend on OverallHeight");
    assert_eq!(overflow.stats.refused_input_elements, 0);
}

/// #7678 review finding 5: a style value refused by admission (an
/// `IfcColourRgb` component `1.E400`) falls back to the default colour, as a
/// refused style must, and the pre-pass counts the refusal instead of doing it
/// silently. The colour served is finite.
#[test]
fn an_overflowing_style_value_falls_back_and_is_counted() {
    let styled = |red: &str| {
        format!(
            "{}#90=IFCCOLOURRGB($,{red},0.,0.);\n#91=IFCSURFACESTYLESHADING(#90,0.);\n\
             #92=IFCSURFACESTYLE('s',.BOTH.,(#91));\n#93=IFCSTYLEDITEM(#203,(#92),$);\n",
            wall(200, "4.", "3.", "0.,0.,1.", "1.,2.,0.")
        )
    };
    let finite = process_geometry(&file(&styled("1.")));
    let overflow = process_geometry(&file(&styled("1.E400")));
    let color = |r: &ifc_lite_processing::ProcessingResult| {
        r.meshes.iter().find(|m| m.express_id == 200).map(|m| m.color).expect("the wall meshes")
    };
    assert_eq!(color(&finite)[0], 1.0, "anti-vacuity: the finite style is applied");
    assert_eq!(finite.stats.refused_prepass_records, 0);
    let fallback = color(&overflow);
    assert!(fallback.iter().all(|c| c.is_finite()), "{fallback:?}");
    assert_ne!(fallback, color(&finite), "the refused style is not applied");
    assert!(overflow.stats.refused_prepass_records >= 1, "the refused style is counted");
}

/// #7678 round-2 review blocker: a declared conversion-based length unit whose
/// factor is unusable (`1.E400`) has no right metre scale. Base drew the model
/// at infinity; round 2 drew it, uncounted, at metres (5x off for a 0.2 m
/// unit). It is now refused for geometry and counted, on the native pipeline,
/// the shared stream meta (wasm, appearance) and any router built from a scale
/// the wire refused; the `0.2` twin still meshes at exactly 0.2 of metres.
#[test]
fn an_unusable_length_unit_factor_refuses_geometry_and_is_counted() {
    let with_unit = |factor: &str| {
        file(&good(100)).replace(
            "#17=IFCUNITASSIGNMENT((#16));",
            &format!(
                "#17=IFCUNITASSIGNMENT((#160));\n#160=IFCCONVERSIONBASEDUNIT(#163,.LENGTHUNIT.,'SURVEY_LINK',#161);\n\
                 #161=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE({factor}),#16);\n#163=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);"
            ),
        )
    };
    let extent = |positions: &[f32]| {
        let xs: Vec<f32> = positions.iter().step_by(3).copied().collect();
        xs.iter().cloned().fold(f32::MIN, f32::max) - xs.iter().cloned().fold(f32::MAX, f32::min)
    };
    let metres = process_geometry(&file(&good(100)));
    let metre_extent = extent(&metres.meshes[0].positions);

    let fifth = process_geometry(&with_unit("0.2"));
    assert_eq!(fifth.meshes.len(), 1, "anti-vacuity: the 0.2 m unit meshes");
    let fifth_extent = extent(&fifth.meshes[0].positions);
    assert!((fifth_extent - 0.2 * metre_extent).abs() < 1e-5, "{fifth_extent} vs 0.2 x {metre_extent}");
    assert_eq!((fifth.stats.refused_input_elements, fifth.stats.refused_prepass_records), (0, 0));
    assert_eq!((fifth.metadata.length_unit_scale, fifth.metadata.length_unit_refused), (Some(0.2), None));

    for factor in ["1.E400", "-1.E400", "0.", "-0.2"] {
        let refused = process_geometry(&with_unit(factor));
        assert!(refused.meshes.is_empty(), "{factor}: no mesh at an invented scale");
        assert_eq!(refused.stats.refused_input_elements, 1, "{factor}: the one element is counted");
        assert!(refused.stats.refused_prepass_records >= 1, "{factor}: the factor is counted");
        // The native metadata (server, ffi) reports the refusal, not an invented 1.0 scale.
        assert_eq!(refused.metadata.length_unit_refused, Some(161), "{factor}: refusal reported");
        assert_eq!(refused.metadata.length_unit_scale, None, "{factor}: no invented scale");
    }

    // The shared stream meta (wasm pre-pass, appearance) carries the refusal,
    // and a router built from the scale the wasm wire sends (NaN) refuses.
    let content = with_unit("1.E400");
    let mut decoder = ifc_lite_core::EntityDecoder::new(&content);
    let meta = ifc_lite_processing::stream_meta::resolve_stream_meta(
        ifc_lite_processing::stream_meta::MetaMode::SmallFileSingle,
        content.as_bytes(),
        None,
        None,
        &mut decoder,
    );
    assert_eq!(meta.length_unit_refused, Some(161));
    assert!(ifc_lite_geometry::GeometryRouter::with_scale(f64::NAN).length_unit_refused());
    assert!(!ifc_lite_geometry::GeometryRouter::with_scale(0.2).length_unit_refused());
}

/// #7678: a refused length unit also refuses every scaled placement, so no
/// consumer of one (the site transform here, export rows, overlays) reads
/// file units as metres where main gave infinity. The `0.2` twin is scaled.
#[test]
fn a_refused_length_unit_refuses_scaled_placements() {
    let with_unit = |factor: &str| {
        file(&format!(
            "#30=IFCCARTESIANPOINT((1000.,2000.,0.));\n#31=IFCAXIS2PLACEMENT3D(#30,$,$);\n#32=IFCLOCALPLACEMENT($,#31);\n\
             #40=IFCSITE('0Site000000000000000001',$,'S',$,$,#32,$,$,.ELEMENT.,$,$,$,$,$);\n\
             #41=IFCRELAGGREGATES('0Agg000000000000000001',$,$,$,#20,(#40));\n{}",
            good(100)
        ))
        .replace(
            "#17=IFCUNITASSIGNMENT((#16));",
            &format!(
                "#17=IFCUNITASSIGNMENT((#160));\n#160=IFCCONVERSIONBASEDUNIT(#163,.LENGTHUNIT.,'SURVEY_LINK',#161);\n\
                 #161=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE({factor}),#16);\n#163=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);"
            ),
        )
    };
    let fifth = process_geometry(&with_unit("0.2")).site_transform.expect("anti-vacuity: the site is placed");
    assert_eq!((fifth[12], fifth[13]), (200.0, 400.0), "1000 x 0.2, 2000 x 0.2");
    for factor in ["1.E400", "0.", "$"] {
        let refused = process_geometry(&with_unit(factor));
        assert_eq!(refused.site_transform, None, "{factor}: no site placement at an invented metre scale");
    }
    let content = with_unit("1.E400");
    let mut decoder = ifc_lite_core::EntityDecoder::new(&content);
    let site = decoder.decode_by_id(40).expect("site decodes");
    let router = ifc_lite_geometry::GeometryRouter::with_scale(f64::NAN);
    assert!(router.resolve_scaled_placement(&site, &mut decoder).is_err());
    assert!(router.resolve_scaled_placement_strict(&site, &mut decoder).is_err());
}
