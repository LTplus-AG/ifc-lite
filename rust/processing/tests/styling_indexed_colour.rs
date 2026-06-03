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
