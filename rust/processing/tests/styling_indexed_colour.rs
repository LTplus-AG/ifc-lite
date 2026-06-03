// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #913 / #663 — the backend must color tessellated geometry from an
//! `IfcIndexedColourMap` (CATIA / 3DEXPERIENCE style) when there is no
//! `IfcStyledItem` chain, instead of falling back to the default type color.
//!
//! Fixture: an `IfcBuildingElementProxy` whose body is an
//! `IfcTriangulatedFaceSet` (a unit tetrahedron) colored green
//! `(0.1, 0.7, 0.3)` purely via `IFCINDEXEDCOLOURMAP` + `IFCCOLOURRGBLIST`.
//! The proxy default is gray `[0.6, 0.6, 0.6, 1.0]`, so a green mesh proves
//! the indexed colour map was honored.

use ifc_lite_processing::process_geometry;

const AUTHORED: [f32; 4] = [0.1, 0.7, 0.3, 1.0];
const PROXY_DEFAULT: [f32; 4] = [0.6, 0.6, 0.6, 1.0];

/// No IFCSTYLEDITEM anywhere — colour comes only from the indexed colour map.
const INDEXED_COLOUR_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-913 indexed colour map fixture'),'2;1');
FILE_NAME('icm.ifc','2026-06-03T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCBUILDINGELEMENTPROXY('1ProxyIndexedColour00',$,'Proxy',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#14));
#14=IFCTRIANGULATEDFACESET(#15,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#15=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#20=IFCCOLOURRGBLIST(((0.1,0.7,0.3)));
#21=IFCINDEXEDCOLOURMAP(#14,$,#20,(1,1,1,1));
ENDSEC;
END-ISO-10303-21;
"#;

fn approx_eq(a: [f32; 4], b: [f32; 4]) -> bool {
    a.iter().zip(b.iter()).all(|(x, y)| (x - y).abs() < 1e-4)
}

#[test]
fn proxy_is_colored_from_indexed_colour_map() {
    let result = process_geometry(INDEXED_COLOUR_IFC);

    let proxy = result
        .meshes
        .iter()
        .find(|m| m.express_id == 10)
        .unwrap_or_else(|| {
            panic!(
                "proxy #10 produced no mesh; got: {:?}",
                result
                    .meshes
                    .iter()
                    .map(|m| (m.express_id, m.ifc_type.as_str(), m.indices.len() / 3))
                    .collect::<Vec<_>>()
            )
        });

    assert!(
        approx_eq(proxy.color, AUTHORED),
        "expected authored indexed-colour {AUTHORED:?}, got {:?} (default would be {PROXY_DEFAULT:?})",
        proxy.color
    );
    assert_ne!(
        proxy.color, PROXY_DEFAULT,
        "mesh fell back to the default proxy color — indexed colour map was ignored"
    );
}

const RED: [f32; 4] = [0.9, 0.1, 0.1, 1.0];
const GREEN: [f32; 4] = [0.1, 0.9, 0.1, 1.0];

/// A unit cube whose 12 triangles are coloured 6 red + 6 green purely via the
/// `ColourIndex` of an `IfcIndexedColourMap` (issue #858). The backend must
/// split it into one sub-mesh per palette group, not collapse to one colour.
const MULTI_COLOUR_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-858 per-triangle colour fixture'),'2;1');
FILE_NAME('icm-multi.ifc','2026-06-03T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCBUILDINGELEMENTPROXY('1ProxyMultiColour000',$,'Proxy',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#14));
#14=IFCTRIANGULATEDFACESET(#15,$,.T.,((1,2,3),(1,3,4),(5,7,6),(5,8,7),(1,5,6),(1,6,2),(2,6,7),(2,7,3),(3,7,8),(3,8,4),(4,8,5),(4,5,1)),$);
#15=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(1.,1.,0.),(0.,1.,0.),(0.,0.,1.),(1.,0.,1.),(1.,1.,1.),(0.,1.,1.)));
#20=IFCCOLOURRGBLIST(((0.9,0.1,0.1),(0.1,0.9,0.1)));
#21=IFCINDEXEDCOLOURMAP(#14,$,#20,(1,1,1,1,1,1,2,2,2,2,2,2));
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn faceset_is_split_per_triangle_palette_group() {
    let result = process_geometry(MULTI_COLOUR_IFC);

    let parts: Vec<&_> = result.meshes.iter().filter(|m| m.express_id == 10).collect();
    assert_eq!(
        parts.len(),
        2,
        "expected one sub-mesh per palette group (red + green), got {} ({:?})",
        parts.len(),
        parts.iter().map(|m| (m.color, m.indices.len() / 3)).collect::<Vec<_>>()
    );

    let red = parts.iter().find(|m| approx_eq(m.color, RED));
    let green = parts.iter().find(|m| approx_eq(m.color, GREEN));
    let red = red.expect("missing red sub-mesh");
    let green = green.expect("missing green sub-mesh");

    assert_eq!(red.indices.len() / 3, 6, "red group should have 6 triangles");
    assert_eq!(green.indices.len() / 3, 6, "green group should have 6 triangles");

    // Every triangle is accounted for, none duplicated.
    let total: usize = parts.iter().map(|m| m.indices.len() / 3).sum();
    assert_eq!(total, 12, "split must preserve the original triangle count");
}
