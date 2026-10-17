// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7684 EXPORT-DATA-6: HBJSON/DFJSON keep survey precision. Two 4.1 m apart
//! spaces at LV95 magnitude must stay 4.1 m apart.

use ifc_lite_export::{export_hbjson, HbjsonOptions};

fn space(id: u32, x: f64) -> String {
    format!(
        "#{p}=IFCCARTESIANPOINT(({x:?},1200000.7,0.));
#{a}=IFCAXIS2PLACEMENT3D(#{p},$,$);
#{l}=IFCLOCALPLACEMENT($,#{a});
#{c}=IFCCARTESIANPOINT((2.,1.5));
#{a2}=IFCAXIS2PLACEMENT2D(#{c},$);
#{r}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#{a2},4.,3.);
#{o}=IFCCARTESIANPOINT((0.,0.,0.));
#{a3}=IFCAXIS2PLACEMENT3D(#{o},$,$);
#{d}=IFCDIRECTION((0.,0.,1.));
#{e}=IFCEXTRUDEDAREASOLID(#{r},#{a3},#{d},2.5);
#{s}=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#{e}));
#{ps}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{s}));
#{id}=IFCSPACE('sp{id}',$,'S{id}',$,$,#{l},#{ps},$,.ELEMENT.,.INTERNAL.,$);
",
        p = id + 1, a = id + 2, l = id + 3, c = id + 4, a2 = id + 5, r = id + 6, o = id + 7,
        a3 = id + 8, d = id + 9, e = id + 10, s = id + 11, ps = id + 12,
    )
}

#[test]
fn issue_7684_spaces_at_lv95_keep_their_relative_position() {
    let ifc = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('0project00000000000001',$,'P',$,$,$,$,(#2),#3);\n\
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);\n#3=IFCUNITASSIGNMENT((#6));\n\
#4=IFCCARTESIANPOINT((0.,0.,0.));\n#5=IFCAXIS2PLACEMENT3D(#4,$,$);\n#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n\
{}{}ENDSEC;\nEND-ISO-10303-21;\n",
        space(100, 2_600_000.3),
        space(200, 2_600_004.4),
    );
    let json: serde_json::Value = serde_json::from_str(&export_hbjson(ifc.as_bytes(), &HbjsonOptions::default())).unwrap();
    let rooms = json["rooms"].as_array().expect("rooms");
    assert_eq!(rooms.len(), 2, "{json}");
    let min_x = |room: &serde_json::Value| {
        room["faces"].as_array().unwrap().iter()
            .flat_map(|f| f["geometry"]["boundary"].as_array().unwrap().iter())
            .map(|p| p[0].as_f64().unwrap())
            .fold(f64::INFINITY, f64::min)
    };
    let gap = (min_x(&rooms[1]) - min_x(&rooms[0])).abs();
    assert!((gap - 4.1).abs() < 1e-3, "rooms are {gap} m apart, authored 4.1 m");
}
