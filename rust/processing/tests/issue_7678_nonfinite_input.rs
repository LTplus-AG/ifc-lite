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

fn file(body: &str) -> String {
    format!("{HEAD}{body}{TAIL}")
}

/// Each case, and whether it reaches D3's refused-element counter. The
/// coordinate-list fast path refuses the list without a decoder, so its
/// element fails closed uncounted (the reader lives in B6e's
/// `processors/tessellated`).
fn poisoned_cases() -> Vec<(&'static str, String, u64)> {
    vec![
        ("extrusion Depth 1.E400", wall(200, "4.", "1.E400", "0.,0.,1.", "1.,2.,0."), 1),
        ("extrusion Depth -1.E400", wall(250, "4.", "-1.E400", "0.,0.,1.", "1.,2.,0."), 1),
        ("profile XDim 1.E400", wall(300, "1.E400", "3.", "0.,0.,1.", "1.,2.,0."), 1),
        ("ExtrudedDirection 1.E400", wall(400, "4.", "3.", "0.,0.,1.E400", "1.,2.,0."), 1),
        ("placement Location 1.E400", wall(500, "4.", "3.", "0.,0.,1.", "1.E400,2.,0."), 1),
        ("f32 point list 1.E39", face_set(600, "1.E39"), 0),
        ("point list 1.E400", face_set(700, "1.E400"), 0),
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
