// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7684 EXPORT-DATA-6 (fixed under #7690): HBJSON/DFJSON keep survey precision.
//! Two spaces authored 4.1 m apart at LV95 magnitude must stay 4.1 m apart. The
//! extractor used to hand the exporters an f32 world transform, whose 0.25 m step
//! at 2.6e6 m moved them to 4.25 m apart.

use ifc_lite_export::{export_dfjson, export_hbjson, DfjsonOptions, HbjsonOptions};

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

/// Two spaces 4.1 m apart in X at LV95.
fn two_lv95_spaces() -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('0project00000000000001',$,'P',$,$,$,$,(#2),#3);\n\
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);\n#3=IFCUNITASSIGNMENT((#6));\n\
#4=IFCCARTESIANPOINT((0.,0.,0.));\n#5=IFCAXIS2PLACEMENT3D(#4,$,$);\n#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n\
{}{}ENDSEC;\nEND-ISO-10303-21;\n",
        space(100, 2_600_000.3),
        space(200, 2_600_004.4),
    )
}

fn min_x<'a>(points: impl Iterator<Item = &'a serde_json::Value>) -> f64 {
    points.map(|p| p[0].as_f64().unwrap()).fold(f64::INFINITY, f64::min)
}

#[test]
fn issue_7684_spaces_at_lv95_keep_their_relative_position() {
    let ifc = two_lv95_spaces();
    let json: serde_json::Value = serde_json::from_str(&export_hbjson(ifc.as_bytes(), &HbjsonOptions::default())).unwrap();
    let rooms = json["rooms"].as_array().expect("rooms");
    assert_eq!(rooms.len(), 2, "{json}");
    let room_min_x = |room: &serde_json::Value| {
        min_x(room["faces"].as_array().unwrap().iter().flat_map(|f| f["geometry"]["boundary"].as_array().unwrap().iter()))
    };
    let gap = (room_min_x(&rooms[1]) - room_min_x(&rooms[0])).abs();
    assert!((gap - 4.1).abs() < 1e-3, "rooms are {gap} m apart, authored 4.1 m");
}

/// The same rebase in the Dragonfly exporter (`Room2D.floor_boundary`).
#[test]
fn issue_7684_dfjson_room_2ds_at_lv95_keep_their_relative_position() {
    let ifc = two_lv95_spaces();
    let json: serde_json::Value = serde_json::from_str(&export_dfjson(ifc.as_bytes(), &DfjsonOptions::default())).unwrap();
    let rooms: Vec<&serde_json::Value> = json["buildings"].as_array().expect("buildings").iter()
        .flat_map(|b| b["unique_stories"].as_array().unwrap().iter())
        .flat_map(|s| s["room_2ds"].as_array().unwrap().iter())
        .collect();
    assert_eq!(rooms.len(), 2, "{json}");
    let gap = (min_x(rooms[1]["floor_boundary"].as_array().unwrap().iter())
        - min_x(rooms[0]["floor_boundary"].as_array().unwrap().iter())).abs();
    assert!((gap - 4.1).abs() < 1e-3, "room_2ds are {gap} m apart, authored 4.1 m");
}

/// A window in the south wall and a railing post beside the space, all at LV95.
/// `openings.rs` and `shades.rs` read the same `ExtractedProfile.transform`
/// through `geom::xf`, so they are pinned here too (#7738 review). In f32 the
/// space origin rounds to 2,600,000.25, the window centre to 2,600,002.0 and the
/// post to 2,600,005.0, so each lands about 5 cm from where it was authored.
fn lv95_space_window_railing() -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('0project00000000000001',$,'P',$,$,$,$,(#2),#3);\n\
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);\n#3=IFCUNITASSIGNMENT((#6));\n\
#4=IFCCARTESIANPOINT((0.,0.,0.));\n#5=IFCAXIS2PLACEMENT3D(#4,$,$);\n#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n\
{space}\
#301=IFCCARTESIANPOINT((2600002.,1200000.7,0.8));\n#302=IFCAXIS2PLACEMENT3D(#301,$,$);\n#303=IFCLOCALPLACEMENT($,#302);\n\
#304=IFCCARTESIANPOINT((0.,0.));\n#305=IFCAXIS2PLACEMENT2D(#304,$);\n\
#306=IFCRECTANGLEPROFILEDEF(.AREA.,$,#305,1.2,0.1);\n#307=IFCDIRECTION((0.,0.,1.));\n\
#308=IFCEXTRUDEDAREASOLID(#306,#5,#307,1.2);\n#309=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#308));\n\
#310=IFCPRODUCTDEFINITIONSHAPE($,$,(#309));\n\
#300=IFCWINDOW('0window000000000000001',$,'W',$,$,#303,#310,$,1.2,1.2,$,$,$);\n\
#401=IFCCARTESIANPOINT((2600005.1,1200001.2,0.));\n#402=IFCAXIS2PLACEMENT3D(#401,$,$);\n#403=IFCLOCALPLACEMENT($,#402);\n\
#404=IFCRECTANGLEPROFILEDEF(.AREA.,$,#305,0.05,0.05);\n\
#405=IFCEXTRUDEDAREASOLID(#404,#5,#307,1.);\n#406=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#405));\n\
#407=IFCPRODUCTDEFINITIONSHAPE($,$,(#406));\n\
#400=IFCRAILING('0railing00000000000001',$,'R',$,$,#403,#407,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n",
        space = space(100, 2_600_000.3),
    )
}

fn min_coord<'a>(points: impl Iterator<Item = &'a serde_json::Value>, k: usize) -> f64 {
    points.map(|p| p[k].as_f64().unwrap()).fold(f64::INFINITY, f64::min)
}

/// The exported HBJSON and the room's min x. Everything is rebased to the
/// room's min corner, so authored offsets from the space's
/// (2,600,000.3, 1,200,000.7, 0) corner are read directly.
fn lv95_hbjson() -> (serde_json::Value, f64) {
    let ifc = lv95_space_window_railing();
    let json: serde_json::Value =
        serde_json::from_str(&export_hbjson(ifc.as_bytes(), &HbjsonOptions::default())).unwrap();
    let faces = json["rooms"].as_array().expect("rooms")[0]["faces"].as_array().unwrap().clone();
    let room_x = min_coord(faces.iter().flat_map(|f| f["geometry"]["boundary"].as_array().unwrap().iter()), 0);
    (json, room_x)
}

#[test]
fn issue_7684_openings_at_lv95_keep_their_relative_position() {
    let (json, room_x) = lv95_hbjson();
    let room = &json["rooms"][0];
    let faces = room["faces"].as_array().unwrap();

    let apertures: Vec<&serde_json::Value> =
        faces.iter().filter_map(|f| f["apertures"].as_array()).flatten().collect();
    assert_eq!(apertures.len(), 1, "one window on the south wall: {room}");
    let boundary = apertures[0]["geometry"]["boundary"].as_array().unwrap();
    let window_x = min_coord(boundary.iter(), 0) - room_x;
    let window_z = min_coord(boundary.iter(), 2);
    assert!((window_x - 1.1).abs() < 1e-3, "window starts {window_x} m along the wall, authored 1.1 m");
    assert!((window_z - 0.8).abs() < 1e-3, "window sill at {window_z} m, authored 0.8 m");
}

#[test]
fn issue_7684_shades_at_lv95_keep_their_relative_position() {
    let (json, room_x) = lv95_hbjson();
    let shades = json["shade_meshes"].as_array().expect("shade_meshes");
    assert_eq!(shades.len(), 1, "one railing shade: {json}");
    let vertices = shades[0]["geometry"]["vertices"].as_array().unwrap();
    let post_x = min_coord(vertices.iter(), 0) - room_x;
    let post_y = min_coord(vertices.iter(), 1);
    assert!((post_x - 4.775).abs() < 1e-3, "post at {post_x} m east of the space, authored 4.775 m");
    assert!((post_y - 0.475).abs() < 1e-3, "post at {post_y} m north of the space, authored 0.475 m");
}
