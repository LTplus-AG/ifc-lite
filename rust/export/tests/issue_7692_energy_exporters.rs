// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7692 (Rust sweep B8): the HBJSON/DFJSON energy exporters.
//!
//! - EXPORT-DATA-4: DFJSON stories ascend by the rooms' own floor heights. The
//!   sort key used to be the declared `IfcBuildingStorey.Elevation` (file units)
//!   where present and the rebased geometric floor (metres) otherwise, so a
//!   millimetre file interleaved the two frames.
//! - EXPORT-DATA-5: an `IfcSpace` modelled as several extruded items yields one
//!   room per item, and every room and face identifier is unique.
//! - EXPORT-DATA-7: every Ladybug identifier matches the honeybee-schema /
//!   dragonfly-schema grammar `^[.A-Za-z0-9_-]+$`, at most 100 characters.
//!
//! Each case goes through raw IFC text and the public export entry points.

use std::collections::HashSet;

use ifc_lite_export::{
    export_dfjson, export_dfjson_with_stats, export_hbjson, export_hbjson_with_stats, DfjsonOptions,
    HbjsonOptions,
};
use serde_json::Value;

/// honeybee-schema `IDdBaseModel.identifier` (and dragonfly-schema's): `^[.A-Za-z0-9_-]+$`,
/// `min_length=1`, `max_length=100`.
fn is_ladybug_identifier(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

const HEADER: &str = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n";
const FOOTER: &str = "ENDSEC;\nEND-ISO-10303-21;\n";

/// Project, a 3D Body context (#2) and a single length unit (`METRE` or millimetre).
fn project(milli: bool) -> String {
    let prefix = if milli { ".MILLI." } else { "$" };
    format!(
        "#1=IFCPROJECT('0project00000000000001',$,'P',$,$,$,$,(#2),#3);\n\
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);\n#3=IFCUNITASSIGNMENT((#6));\n\
#4=IFCCARTESIANPOINT((0.,0.,0.));\n#5=IFCAXIS2PLACEMENT3D(#4,$,$);\n#6=IFCSIUNIT(*,.LENGTHUNIT.,{prefix},.METRE.);\n"
    )
}

/// One `IfcExtrudedAreaSolid` rectangle (`w` x `d`, centred at `(cx, cy)` in the profile
/// plane) extruded `h` straight up. Uses ids `base..base+6`; the solid is `#base+6`.
fn rect_solid(base: u32, cx: f64, cy: f64, w: f64, d: f64, h: f64) -> String {
    let (c, a2, r, o, a3, dir, e) = (base, base + 1, base + 2, base + 3, base + 4, base + 5, base + 6);
    format!(
        "#{c}=IFCCARTESIANPOINT(({cx:?},{cy:?}));\n#{a2}=IFCAXIS2PLACEMENT2D(#{c},$);\n\
#{r}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#{a2},{w:?},{d:?});\n#{o}=IFCCARTESIANPOINT((0.,0.,0.));\n\
#{a3}=IFCAXIS2PLACEMENT3D(#{o},$,$);\n#{dir}=IFCDIRECTION((0.,0.,1.));\n\
#{e}=IFCEXTRUDEDAREASOLID(#{r},#{a3},#{dir},{h:?});\n"
    )
}

/// An `IfcSpace` `#id` placed at `(x, 0, z)` whose Body is the given extruded items.
/// The space's own rows use ids `id+1..id+5`; each item `k` uses `id+10+10k..`.
fn space(id: u32, x: f64, z: f64, items: &[(f64, f64, f64, f64, f64)]) -> String {
    let mut out = String::new();
    let mut refs = Vec::new();
    for (k, &(cx, cy, w, d, h)) in items.iter().enumerate() {
        let base = id + 10 + 10 * k as u32;
        out.push_str(&rect_solid(base, cx, cy, w, d, h));
        refs.push(format!("#{}", base + 6));
    }
    let (p, a, l, s, ps) = (id + 1, id + 2, id + 3, id + 4, id + 5);
    out.push_str(&format!(
        "#{p}=IFCCARTESIANPOINT(({x:?},0.,{z:?}));\n#{a}=IFCAXIS2PLACEMENT3D(#{p},$,$);\n#{l}=IFCLOCALPLACEMENT($,#{a});\n\
#{s}=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',({}));\n#{ps}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{s}));\n\
#{id}=IFCSPACE('sp{id}',$,'S{id}',$,$,#{l},#{ps},$,.ELEMENT.,.INTERNAL.,$);\n",
        refs.join(",")
    ));
    out
}

fn ifc(milli: bool, body: &str) -> String {
    format!("{HEADER}{}{body}{FOOTER}", project(milli))
}

fn hbjson(ifc: &str, name: &str) -> Value {
    let opts = HbjsonOptions { name: name.to_string(), ..HbjsonOptions::default() };
    serde_json::from_str(&export_hbjson(ifc.as_bytes(), &opts)).expect("HBJSON parses")
}

fn dfjson(ifc: &str, name: &str) -> Value {
    let opts = DfjsonOptions { name: name.to_string(), ..DfjsonOptions::default() };
    serde_json::from_str(&export_dfjson(ifc.as_bytes(), &opts)).expect("DFJSON parses")
}

fn stories(df: &Value) -> Vec<&Value> {
    df["buildings"].as_array().expect("buildings").iter()
        .flat_map(|b| b["unique_stories"].as_array().expect("stories").iter())
        .collect()
}

fn room_2ds(df: &Value) -> Vec<&Value> {
    stories(df).into_iter().flat_map(|s| s["room_2ds"].as_array().expect("room_2ds").iter()).collect()
}

/// Every `identifier` anywhere in the document, with its JSON path.
fn identifiers<'a>(v: &'a Value, path: String, out: &mut Vec<(String, &'a str)>) {
    match v {
        Value::Object(m) => {
            for (k, child) in m {
                if k == "identifier" {
                    if let Some(s) = child.as_str() {
                        out.push((path.clone(), s));
                    }
                }
                identifiers(child, format!("{path}.{k}"), out);
            }
        }
        Value::Array(a) => {
            for (i, child) in a.iter().enumerate() {
                identifiers(child, format!("{path}[{i}]"), out);
            }
        }
        _ => {}
    }
}

/// EXPORT-DATA-4: storeys at Elevation 0 / 3000 (millimetres) and an attic whose
/// Elevation is unset (`$`), with rooms at 0, 3 and 6 m. The attic's key used to be its
/// rebased floor in metres (6.0), which sorts below Level 2's raw 3000, so the attic
/// was emitted as the middle story and Level 2 was flagged top-exposed.
#[test]
fn issue_7692_export_data_4_dfjson_stories_ascend_by_floor_height_in_a_millimetre_file() {
    let room = [(2000.0, 1500.0, 4000.0, 3000.0, 2500.0)];
    let body = format!(
        "#40=IFCBUILDING('b',$,'House',$,$,$,$,$,.ELEMENT.,$,$,$);\n\
#41=IFCBUILDINGSTOREY('s1',$,'Level 1',$,$,$,$,$,.ELEMENT.,0.);\n\
#42=IFCBUILDINGSTOREY('s2',$,'Level 2',$,$,$,$,$,.ELEMENT.,3000.);\n\
#43=IFCBUILDINGSTOREY('s3',$,'Attic',$,$,$,$,$,.ELEMENT.,$);\n\
{}{}{}\
#50=IFCRELAGGREGATES('a1',$,$,$,#1,(#40));\n#51=IFCRELAGGREGATES('a2',$,$,$,#40,(#41,#42,#43));\n\
#52=IFCRELAGGREGATES('a3',$,$,$,#41,(#100));\n#53=IFCRELAGGREGATES('a4',$,$,$,#42,(#200));\n\
#54=IFCRELAGGREGATES('a5',$,$,$,#43,(#300));\n",
        space(100, 0.0, 0.0, &room),
        space(200, 0.0, 3000.0, &room),
        space(300, 0.0, 6000.0, &room),
    );
    let df = dfjson(&ifc(true, &body), "m");
    let st = stories(&df);
    let names: Vec<&str> = st.iter().map(|s| s["display_name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Level 1", "Level 2", "Attic"], "{df}");
    let floors: Vec<f64> = st.iter().map(|s| s["floor_height"].as_f64().unwrap()).collect();
    assert!(floors.windows(2).all(|w| w[0] < w[1]), "stories must ascend: {floors:?}");
    for (s, ftf) in st.iter().zip([3.0, 3.0]) {
        let got = s["floor_to_floor_height"].as_f64().unwrap();
        assert!((got - ftf).abs() < 1e-6, "{}: floor_to_floor {got}, want {ftf}", s["display_name"]);
    }
    let rooms = room_2ds(&df);
    let flags: Vec<(bool, bool)> = rooms
        .iter()
        .map(|r| (r["is_ground_contact"].as_bool().unwrap(), r["is_top_exposed"].as_bool().unwrap()))
        .collect();
    assert_eq!(flags, [(true, false), (false, false), (false, true)], "ground on Level 1, roof on the attic");
}

/// EXPORT-DATA-5: one `IfcSpace` (an L) modelled as two extruded rectangles. Both
/// pieces are exported, and no two rooms (or faces) share an identifier — Honeybee and
/// Dragonfly refuse a model with duplicate room identifiers.
#[test]
fn issue_7692_export_data_5_a_multi_item_space_gets_unique_room_ids() {
    let body = space(100, 0.0, 0.0, &[(2.0, 1.5, 4.0, 3.0, 2.5), (1.0, 4.5, 2.0, 3.0, 2.5)])
        + &space(200, 10.0, 0.0, &[(2.0, 1.5, 4.0, 3.0, 2.5)]);
    let ifc = ifc(false, &body);

    let (json, stats) = export_hbjson_with_stats(ifc.as_bytes(), &HbjsonOptions::default());
    let hb: Value = serde_json::from_str(&json).unwrap();
    let room_ids: Vec<&str> = hb["rooms"].as_array().unwrap().iter().map(|r| r["identifier"].as_str().unwrap()).collect();
    assert_eq!(room_ids, ["R100", "R100_1", "R200"], "one room per piece, the first piece keeps R<id>");
    assert_eq!(stats.spaces, stats.rooms + stats.skipped, "coverage invariant, counted per piece");
    let mut all = Vec::new();
    identifiers(&hb, String::new(), &mut all);
    let mut seen = HashSet::new();
    for (path, id) in &all {
        assert!(seen.insert(*id), "duplicate HBJSON identifier {id} at {path}");
    }

    let (json, stats) = export_dfjson_with_stats(ifc.as_bytes(), &DfjsonOptions::default());
    let df: Value = serde_json::from_str(&json).unwrap();
    let mut ids: Vec<&str> = room_2ds(&df).iter().map(|r| r["identifier"].as_str().unwrap()).collect();
    ids.sort_unstable();
    assert_eq!(ids, ["R100", "R100_1", "R200"], "the same piece ids as HBJSON");
    assert_eq!(stats.spaces, stats.rooms + stats.skipped);
}

/// A 4 x 3 m wall and its two-layer build-up, whose material names are `long_a` and
/// `long_b`, plus one space so the model has a room to assign constructions to.
fn walled_model(long_a: &str, long_b: &str) -> String {
    let wall = rect_solid(500, 2.0, 0.1, 4.0, 0.2, 3.0);
    let body = format!(
        "{}{wall}\
#510=IFCCARTESIANPOINT((0.,-1.,0.));\n#511=IFCAXIS2PLACEMENT3D(#510,$,$);\n#512=IFCLOCALPLACEMENT($,#511);\n\
#513=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#506));\n#514=IFCPRODUCTDEFINITIONSHAPE($,$,(#513));\n\
#520=IFCWALL('0wall00000000000000001',$,'W',$,$,#512,#514,$,$);\n\
#530=IFCMATERIAL('{long_a}',$,$);\n#531=IFCMATERIAL('{long_b}',$,$);\n\
#532=IFCMATERIALLAYER(#530,0.1,$,'A',$,$,$);\n#533=IFCMATERIALLAYER(#531,0.1,$,'B',$,$,$);\n\
#534=IFCMATERIALLAYERSET((#532,#533),'Build-up',$);\n#535=IFCMATERIALLAYERSETUSAGE(#534,.AXIS2.,.POSITIVE.,0.,$);\n\
#536=IFCRELASSOCIATESMATERIAL('0assoc0000000000000001',$,$,$,(#520),#535);\n",
        space(100, 0.0, 0.0, &[(2.0, 1.5, 4.0, 3.0, 2.5)]),
    );
    ifc(false, &body)
}

/// EXPORT-DATA-7: a non-ASCII model name and over-long material names. The model
/// identifier is the honeybee grammar (ASCII, `.` kept); the display name keeps what
/// the caller wrote. Two 110-character material names that differ only past
/// character 100 stay two materials rather than truncating into one.
#[test]
fn issue_7692_export_data_7_every_identifier_matches_the_ladybug_grammar() {
    let stem = "x".repeat(110);
    let (insulation, concrete) = (format!("{stem} insulation"), format!("{stem} concrete"));
    let ifc = walled_model(&insulation, &concrete);

    let hb = hbjson(&ifc, "Bürogebäude.v2");
    assert_eq!(hb["identifier"], "B_rogeb_ude.v2");
    assert_eq!(hb["display_name"], "Bürogebäude.v2", "display names are free text and keep the caller's name");
    let materials = hb["properties"]["energy"]["materials"].as_array().expect("materials emitted");
    assert_eq!(materials.len(), 2, "{materials:?}");
    let mat_ids: HashSet<&str> = materials.iter().map(|m| m["identifier"].as_str().unwrap()).collect();
    assert_eq!(mat_ids.len(), 2, "distinct materials keep distinct identifiers: {mat_ids:?}");
    let conductivity: Vec<f64> = materials.iter().map(|m| m["conductivity"].as_f64().unwrap()).collect();
    assert_eq!(conductivity, [0.035, 2.3], "each identifier keeps its own material's properties");
    let mut all = Vec::new();
    identifiers(&hb, String::new(), &mut all);
    for (path, id) in &all {
        assert!(is_ladybug_identifier(id), "HBJSON identifier {id:?} at {path} breaks ^[.A-Za-z0-9_-]{{1,100}}$");
    }

    let long = "Ä".repeat(150);
    for name in ["Bürogebäude.v2", long.as_str(), ""] {
        let df = dfjson(&ifc, name);
        let id = df["identifier"].as_str().unwrap();
        assert!(is_ladybug_identifier(id), "DFJSON model identifier {id:?} for {name:?}");
        let mut all = Vec::new();
        identifiers(&df, String::new(), &mut all);
        for (path, id) in &all {
            assert!(is_ladybug_identifier(id), "DFJSON identifier {id:?} at {path}");
        }
        let hb = hbjson(&ifc, name);
        assert_eq!(hb["identifier"], df["identifier"], "one sanitizer for both formats");
    }
    assert_eq!(dfjson(&ifc, &long)["identifier"].as_str().unwrap().len(), 100, "truncated, not refused");
}
