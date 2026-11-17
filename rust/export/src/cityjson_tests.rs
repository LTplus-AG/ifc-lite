// SPDX-License-Identifier: MPL-2.0
//! CityJSON export: mapping, georeferencing, quantisation and validity.
//!
//! The inline model is an L-shaped building of two boxes (a 10 x 4 m wall
//! block 3 m high and a 4 x 4 m slab block 6 m high) with one room, placed
//! at (1000, 2000, 0) mm. Its footprint is 56 m²; its convex hull would be
//! 68 m², so the area pins that the outline is the real projection.

use std::collections::HashMap;

use serde_json::Value;

use super::georef::epsg_code;
use super::*;

const MAP_IFC4: &str = "#90=IFCPROJECTEDCRS('EPSG:2056',$,'CH1903+','LN02',$,$,#91);\n#91=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n#92=IFCMAPCONVERSION(#5,#90,2600000.,1200000.,400.,0.8660254037844387,0.5,0.001);";
const MAP_IFC4X3_SCALED: &str = "#90=IFCPROJECTEDCRS('EPSG:2056',$,'CH1903+','LN02',$,$,#91);\n#91=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n#92=IFCMAPCONVERSIONSCALED(#5,#90,2600000.,1200000.,400.,0.8660254037844387,0.5,0.001,0.9996,0.999,1.002);";

/// A box `[x0,x1] x [y0,y1] x [0,h]` (mm, element-local) as an extruded
/// polyline profile, numbered from `base`.
fn boxed(base: u32, x0: f64, y0: f64, x1: f64, y1: f64, h: f64) -> (String, u32) {
    let b = base;
    let s = format!(
        "#{b}=IFCCARTESIANPOINT(({x0},{y0}));\n#{}=IFCCARTESIANPOINT(({x1},{y0}));\n#{}=IFCCARTESIANPOINT(({x1},{y1}));\n#{}=IFCCARTESIANPOINT(({x0},{y1}));\n\
#{}=IFCPOLYLINE((#{b},#{},#{},#{},#{b}));\n#{}=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#{});\n#{}=IFCEXTRUDEDAREASOLID(#{},#20,#21,{h});\n\
#{}=IFCSHAPEREPRESENTATION(#6,'Body','SweptSolid',(#{}));\n#{}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{}));\n",
        b + 1, b + 2, b + 3, b + 4, b + 1, b + 2, b + 3, b + 5, b + 4, b + 6, b + 5, b + 7, b + 6, b + 8, b + 7,
    );
    (s, b + 8)
}

/// The test model. `georef` is a map conversion block (or empty);
/// `extra_building` adds a second building as a `BuildingPart` of the first
/// when `part`, else beside it under the site.
fn model(schema: &str, georef: &str, second: Option<bool>) -> String {
    let (wall, wall_shape) = boxed(200, 0.0, 0.0, 10000.0, 4000.0, 3000.0);
    let (slab, slab_shape) = boxed(220, 0.0, 4000.0, 4000.0, 8000.0, 6000.0);
    let (space, space_shape) = boxed(240, 1000.0, 1000.0, 3000.0, 3000.0, 2500.0);
    let (other, other_shape) = boxed(260, 20000.0, 0.0, 26000.0, 5000.0, 9000.0);
    let second_block = match second {
        None => String::new(),
        Some(part) => format!(
            "{other}#300=IFCLOCALPLACEMENT(#31,#34);\n#301=IFCBUILDING('3Bld2ndBuilding0000002',$,'Annex',$,$,#300,$,$,.ELEMENT.,$,$,$);\n\
#302=IFCLOCALPLACEMENT(#300,#34);\n#303=IFCWALL('3Wal2ndBuilding0000003',$,'Annex wall',$,$,#302,#{other_shape},$,$);\n\
#304=IFCRELAGGREGATES('3Rel2ndBuilding0000004',$,$,$,{},(#301));\n#305=IFCRELCONTAINEDINSPATIALSTRUCTURE('3Rel2ndBuilding0000005',$,$,$,(#303),#301);\n",
            if part { "#41" } else { "#40" }
        ),
    };
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');\nFILE_SCHEMA(('{schema}'));\nENDSEC;\nDATA;\n\
#1=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);\n#2=IFCUNITASSIGNMENT((#1));\n#3=IFCCARTESIANPOINT((0.,0.,0.));\n#4=IFCAXIS2PLACEMENT3D(#3,$,$);\n\
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#4,$);\n#6=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#5,$,.MODEL_VIEW.,$);\n\
#7=IFCPROJECT('0Prj0000000000000000P1',$,'Demo project',$,$,$,$,(#5),#2);\n{georef}\n\
#20=IFCAXIS2PLACEMENT3D(#3,$,$);\n#21=IFCDIRECTION((0.,0.,1.));\n\
#30=IFCLOCALPLACEMENT($,#4);\n#31=IFCLOCALPLACEMENT(#30,#4);\n#32=IFCLOCALPLACEMENT(#31,#4);\n#33=IFCCARTESIANPOINT((1000.,2000.,0.));\n#34=IFCAXIS2PLACEMENT3D(#33,$,$);\n#35=IFCLOCALPLACEMENT(#32,#34);\n\
#40=IFCSITE('0Sit0000000000000000S1',$,'Site',$,$,#30,$,$,.ELEMENT.,$,$,$,$,$);\n\
#41=IFCBUILDING('0Bld0000000000000000B1',$,'Main',$,$,#31,$,$,.ELEMENT.,$,$,$);\n\
#42=IFCBUILDINGSTOREY('0Sty0000000000000000T1',$,'Ground floor',$,$,#32,$,$,.ELEMENT.,1500.);\n\
{wall}#50=IFCWALL('0Wal0000000000000000W1',$,'Wall block',$,$,#35,#{wall_shape},$,.SOLIDWALL.);\n\
{slab}#51=IFCSLAB('0Slb0000000000000000L1',$,'Slab block',$,$,#35,#{slab_shape},$,.FLOOR.);\n\
{space}#52=IFCSPACE('0Spc0000000000000000R1',$,'R01',$,$,#35,#{space_shape},'Living',.ELEMENT.,.INTERNAL.,$);\n\
#53=IFCOPENINGELEMENT('0Opn0000000000000000O1',$,'void',$,$,#35,$,$,.OPENING.);\n\
#60=IFCRELAGGREGATES('0Rel0000000000000000A1',$,$,$,#7,(#40));\n#61=IFCRELAGGREGATES('0Rel0000000000000000A2',$,$,$,#40,(#41));\n\
#62=IFCRELAGGREGATES('0Rel0000000000000000A3',$,$,$,#41,(#42));\n#63=IFCRELAGGREGATES('0Rel0000000000000000A4',$,$,$,#42,(#52));\n\
#64=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Rel0000000000000000C1',$,$,$,(#50,#51,#53),#42);\n\
#70=IFCPROPERTYSET('0Pst0000000000000000P1',$,'Pset_BuildingCommon',$,(#71,#72));\n#71=IFCPROPERTYSINGLEVALUE('YearOfConstruction',$,IFCLABEL('1984'),$);\n\
#72=IFCPROPERTYSINGLEVALUE('IsLandmarked',$,IFCBOOLEAN(.F.),$);\n#73=IFCPROPERTYSET('0Pst0000000000000000P2',$,'CH_Register',$,(#74));\n\
#74=IFCPROPERTYSINGLEVALUE('EGID',$,IFCIDENTIFIER('190123456'),$);\n#75=IFCPROPERTYSET('0Pst0000000000000000P3',$,'CH_Parcel',$,(#76));\n\
#76=IFCPROPERTYSINGLEVALUE('egrid',$,IFCIDENTIFIER('CH123456789012'),$);\n#77=IFCPROPERTYSET('0Pst0000000000000000P4',$,'Pset_WallCommon',$,(#78));\n\
#78=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);\n\
#80=IFCRELDEFINESBYPROPERTIES('0Rel0000000000000000D1',$,$,$,(#41),#70);\n#81=IFCRELDEFINESBYPROPERTIES('0Rel0000000000000000D2',$,$,$,(#41),#73);\n\
#82=IFCRELDEFINESBYPROPERTIES('0Rel0000000000000000D3',$,$,$,(#40),#75);\n#83=IFCRELDEFINESBYPROPERTIES('0Rel0000000000000000D4',$,$,$,(#50),#77);\n\
{second_block}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

fn export(content: &str, opts: &CityJsonOptions) -> (CityJsonExport, Value) {
    let out = try_export_cityjson(content.as_bytes(), opts).expect("export");
    let doc: Value = serde_json::from_str(&out.text).expect("json");
    (out, doc)
}

/// Decoded real-world vertices of a CityJSON document.
pub(super) fn real_vertices(doc: &Value) -> Vec<[f64; 3]> {
    let s = &doc["transform"]["scale"];
    let t = &doc["transform"]["translate"];
    doc["vertices"].as_array().unwrap().iter().map(|v| {
        let mut p = [0.0; 3];
        for (k, slot) in p.iter_mut().enumerate() {
            *slot = v[k].as_i64().unwrap() as f64 * s[k].as_f64().unwrap() + t[k].as_f64().unwrap();
        }
        p
    }).collect()
}

/// Every surface (list of rings) of a geometry, whatever its type.
pub(super) fn surfaces(g: &Value) -> Vec<Vec<Vec<usize>>> {
    let ring = |r: &Value| r.as_array().unwrap().iter().map(|i| i.as_u64().unwrap() as usize).collect::<Vec<_>>();
    let surface = |s: &Value| s.as_array().unwrap().iter().map(ring).collect::<Vec<_>>();
    let b = &g["boundaries"];
    match g["type"].as_str().unwrap() {
        "MultiSurface" | "CompositeSurface" => b.as_array().unwrap().iter().map(surface).collect(),
        "Solid" => b.as_array().unwrap().iter().flat_map(|shell| shell.as_array().unwrap().iter().map(surface)).collect(),
        other => panic!("unexpected geometry type {other}"),
    }
}

/// Structural validity the JSON schema cannot express: indices in range,
/// reciprocal parent/children links, and every LoD1 `Solid` a closed,
/// consistently oriented shell (each directed edge used once, its reverse once).
pub(super) fn assert_valid(doc: &Value) {
    let n = doc["vertices"].as_array().unwrap().len();
    let objs = doc["CityObjects"].as_object().unwrap();
    let mut referenced = vec![false; n];
    for (id, o) in objs {
        for p in o.get("parents").and_then(Value::as_array).into_iter().flatten() {
            let parent = &objs[p.as_str().unwrap()];
            assert!(parent["children"].as_array().unwrap().iter().any(|c| c == id), "{id} missing from its parent's children");
        }
        for g in o.get("geometry").and_then(Value::as_array).into_iter().flatten() {
            for s in surfaces(g) {
                for r in &s {
                    assert!(r.len() >= 3 && r.iter().all(|&i| i < n), "{id}: bad ring {r:?}");
                    r.iter().for_each(|&i| referenced[i] = true);
                }
            }
            if g["type"] == "Solid" {
                let mut edges: HashMap<(usize, usize), i32> = HashMap::new();
                for s in surfaces(g) {
                    for r in s {
                        for k in 0..r.len() {
                            *edges.entry((r[k], r[(k + 1) % r.len()])).or_default() += 1;
                        }
                    }
                }
                for (&(a, b), &c) in &edges {
                    assert_eq!(c, 1, "{id}: directed edge {a}->{b} used {c} times");
                    assert_eq!(edges.get(&(b, a)), Some(&1), "{id}: edge {a}->{b} has no opposite");
                }
            }
        }
    }
    assert!(referenced.iter().all(|&r| r), "every vertex is referenced (cjval unused_vertices)");
}

pub(super) fn lod<'a>(o: &'a Value, lod: &str) -> &'a Value {
    o["geometry"].as_array().unwrap().iter().find(|g| g["lod"] == lod).unwrap_or_else(|| panic!("no LoD {lod}"))
}

/// Planimetric area of an LoD0 MultiSurface (exterior minus holes).
fn area(g: &Value, verts: &[[f64; 3]]) -> f64 {
    // Relative to one vertex: shoelace products of 1e6-magnitude map
    // coordinates would cancel away the millimetres.
    let o = verts[surfaces(g)[0][0][0]];
    let ring_area = |r: &[usize]| {
        (0..r.len()).map(|k| {
            let (p, q) = (verts[r[k]], verts[r[(k + 1) % r.len()]]);
            let (a, b) = ([p[0] - o[0], p[1] - o[1]], [q[0] - o[0], q[1] - o[1]]);
            a[0] * b[1] - b[0] * a[1]
        }).sum::<f64>() / 2.0
    };
    surfaces(g).iter().map(|s| s.iter().map(|r| ring_area(r)).sum::<f64>()).sum()
}

#[test]
fn georeferenced_control_point_lands_on_its_integer_vertex() {
    let (out, doc) = export(&model("IFC4", MAP_IFC4, None), &CityJsonOptions::default());
    assert_eq!(out.reference_system.as_deref(), Some("https://www.opengis.net/def/crs/EPSG/0/2056"));
    assert_eq!(doc["metadata"]["referenceSystem"], "https://www.opengis.net/def/crs/EPSG/0/2056");
    assert_valid(&doc);
    // Control point: the building corner at IFC world (1000, 2000, 0) mm.
    // By hand from the IfcMapConversion: x' = 0.001·1000 = 1 m, y' = 2 m,
    // E = cos·x' − sin·y' + 2 600 000, N = sin·x' + cos·y' + 1 200 000,
    // H = 0.001·0 + 400.
    let (c, s) = (0.8660254037844387_f64, 0.5_f64);
    let expect = [c * 1.0 - s * 2.0 + 2_600_000.0, s * 1.0 + c * 2.0 + 1_200_000.0, 400.0];
    let scale = doc["transform"]["scale"][0].as_f64().unwrap();
    let translate: Vec<f64> = doc["transform"]["translate"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    let integer: Vec<i64> = (0..3).map(|k| ((expect[k] - translate[k]) / scale).round() as i64).collect();
    let verts = doc["vertices"].as_array().unwrap();
    let at = verts.iter().position(|v| (0..3).all(|k| v[k].as_i64() == Some(integer[k]))).expect("control vertex present");
    let building = &doc["CityObjects"]["0Bld0000000000000000B1"];
    let footprint = surfaces(lod(building, "0"));
    assert!(footprint.iter().flatten().flatten().any(|&i| i == at), "control vertex is a footprint vertex");
    let real = real_vertices(&doc)[at];
    for k in 0..3 {
        assert!((real[k] - expect[k]).abs() <= scale / 2.0 + 1e-9, "axis {k}: {} vs {}", real[k], expect[k]);
    }
}

#[test]
fn footprint_is_the_real_outline_and_the_block_is_a_closed_solid() {
    let (_, doc) = export(&model("IFC4", MAP_IFC4, None), &CityJsonOptions::default());
    let verts = real_vertices(&doc);
    let b = &doc["CityObjects"]["0Bld0000000000000000B1"];
    assert_eq!(b["type"], "Building");
    // L shape: 10x4 + 4x4 m. Rotation and the 0.001 scale preserve it in metres.
    let a = area(lod(b, "0"), &verts);
    // Corners rotated 30° snap to the 1 mm grid: up to perimeter x 0.5 mm.
    assert!((a - 56.0).abs() < 36.0 * 0.0005, "footprint area {a}");
    assert_eq!(surfaces(lod(b, "0"))[0][0].len(), 6, "an L has six corners");
    let block = lod(b, "1");
    assert_eq!(block["type"], "Solid");
    assert_eq!(block["semantics"]["surfaces"][0]["type"], "GroundSurface");
    // Height: the slab block reaches 6 m.
    assert!((b["attributes"]["measuredHeight"].as_f64().unwrap() - 6.0).abs() < 1e-6);
    let zs: Vec<f64> = surfaces(block).iter().flatten().flatten().map(|&i| verts[i][2]).collect();
    assert!((zs.iter().cloned().fold(f64::MAX, f64::min) - 400.0).abs() < 1e-9);
    assert!((zs.iter().cloned().fold(f64::MIN, f64::max) - 406.0).abs() < 1e-9);
}

#[test]
fn per_axis_factors_of_ifc4x3_scaled_conversion_are_applied() {
    let (out, doc) = export(&model("IFC4X3_ADD2", MAP_IFC4X3_SCALED, None), &CityJsonOptions::default());
    assert!(out.reference_system.is_some(), "{:?}", out.warnings);
    let (c, s) = (0.8660254037844387_f64, 0.5_f64);
    let (x, y) = (0.001 * 0.9996 * 1000.0, 0.001 * 0.999 * 2000.0);
    let expect = [c * x - s * y + 2_600_000.0, s * x + c * y + 1_200_000.0, 400.0];
    let verts = real_vertices(&doc);
    assert!(verts.iter().any(|v| (0..3).all(|k| (v[k] - expect[k]).abs() <= 0.0005)), "control point with factors");
    // FactorZ scales heights: the 6 m block is 6.012 m.
    let h = doc["CityObjects"]["0Bld0000000000000000B1"]["attributes"]["measuredHeight"].as_f64().unwrap();
    assert!((h - 6.012).abs() < 1e-6, "{h}");
}

#[test]
fn unreferenced_model_exports_local_metres_with_a_warning() {
    let (out, doc) = export(&model("IFC4", "", None), &CityJsonOptions::default());
    assert!(out.reference_system.is_none());
    assert!(doc["metadata"].get("referenceSystem").is_none());
    assert!(out.warnings.iter().any(|w| w.contains("not georeferenced") && w.contains("no IfcMapConversion")), "{:?}", out.warnings);
    let verts = real_vertices(&doc);
    assert!(verts.iter().any(|v| (v[0] - 1.0).abs() < 1e-9 && (v[1] - 2.0).abs() < 1e-9 && v[2].abs() < 1e-9), "corner at (1, 2, 0) m");
    assert_valid(&doc);
}

#[test]
fn a_crs_name_that_is_not_an_epsg_code_is_not_claimed() {
    let named = MAP_IFC4.replace("'EPSG:2056'", "'CH1903+ / LV95'");
    let (out, doc) = export(&model("IFC4", &named, None), &CityJsonOptions::default());
    assert!(out.reference_system.is_none());
    assert!(out.warnings.iter().any(|w| w.contains("not an EPSG code")), "{:?}", out.warnings);
    // Local, not half-converted: the corner is at (1, 2, 0) m.
    assert!(real_vertices(&doc).iter().any(|v| (v[0] - 1.0).abs() < 1e-9 && (v[1] - 2.0).abs() < 1e-9));
}

#[test]
fn hierarchy_attributes_and_swiss_identifiers() {
    let (_, doc) = export(&model("IFC4", MAP_IFC4, None), &CityJsonOptions::default());
    let objs = doc["CityObjects"].as_object().unwrap();
    let b = &objs["0Bld0000000000000000B1"];
    let a = &b["attributes"];
    assert_eq!(a["GlobalId"], "0Bld0000000000000000B1");
    assert_eq!(a["ifcClass"], "IfcBuilding");
    assert_eq!(a["Name"], "Main");
    assert_eq!(a["EGID"], "190123456");
    assert_eq!(a["EGRID"], "CH123456789012", "from the site's property set");
    assert_eq!(a["yearOfConstruction"], 1984);
    assert_eq!(a["ifcPropertySets"]["Pset_BuildingCommon"]["IsLandmarked"], false);
    let storey = &objs["0Sty0000000000000000T1"];
    assert_eq!(storey["type"], "BuildingStorey");
    assert_eq!(storey["parents"][0], "0Bld0000000000000000B1");
    assert_eq!(storey["attributes"]["Elevation"], 1.5, "1500 mm in metres");
    assert!(storey.get("geometry").is_none());
    let wall = &objs["0Wal0000000000000000W1"];
    assert_eq!(wall["type"], "BuildingConstructiveElement");
    assert_eq!(wall["parents"][0], "0Bld0000000000000000B1", "elements hang off the building, not the storey");
    assert_eq!(wall["attributes"]["ifcBuildingStorey"], "0Sty0000000000000000T1");
    assert_eq!(wall["attributes"]["PredefinedType"], "SOLIDWALL");
    assert_eq!(wall["attributes"]["ifcPropertySets"]["Pset_WallCommon"]["IsExternal"], true);
    assert_eq!(lod(wall, "3")["type"], "MultiSurface");
    let room = &objs["0Spc0000000000000000R1"];
    assert_eq!(room["type"], "BuildingRoom");
    assert_eq!(room["attributes"]["LongName"], "Living");
    assert!(!objs.contains_key("0Opn0000000000000000O1"), "openings are cutters, not city objects");
    assert_valid(&doc);
}

#[test]
fn blocks_only_keeps_objects_but_drops_element_geometry() {
    let opts = CityJsonOptions { element_geometry: false, ..CityJsonOptions::default() };
    let (_, doc) = export(&model("IFC4", MAP_IFC4, None), &opts);
    let objs = doc["CityObjects"].as_object().unwrap();
    assert!(objs["0Wal0000000000000000W1"].get("geometry").is_none());
    assert_eq!(objs["0Bld0000000000000000B1"]["geometry"].as_array().unwrap().len(), 2);
}

#[test]
fn second_building_and_building_part() {
    let (out, doc) = export(&model("IFC4", MAP_IFC4, Some(false)), &CityJsonOptions::default());
    assert_eq!(out.buildings, 2);
    assert_eq!(doc["CityObjects"]["3Bld2ndBuilding0000002"]["type"], "Building");
    assert_valid(&doc);

    let (out, doc) = export(&model("IFC4", MAP_IFC4, Some(true)), &CityJsonOptions::default());
    assert_eq!(out.buildings, 1);
    let objs = doc["CityObjects"].as_object().unwrap();
    let part = &objs["3Bld2ndBuilding0000002"];
    assert_eq!(part["type"], "BuildingPart");
    assert_eq!(part["parents"][0], "0Bld0000000000000000B1");
    assert_eq!(objs["3Wal2ndBuilding0000003"]["parents"][0], "3Bld2ndBuilding0000002");
    // The main building's footprint now holds both: the L and the 6x5 m annex.
    let verts = real_vertices(&doc);
    let a = area(lod(&objs["0Bld0000000000000000B1"], "0"), &verts);
    assert!((a - 86.0).abs() < 58.0 * 0.0005, "{a}");
    assert_eq!(lod(&objs["0Bld0000000000000000B1"], "1")["type"], "MultiSurface", "two disjoint blocks are not one solid");
    assert_valid(&doc);
}

#[test]
fn sequence_holds_one_feature_per_building_with_local_vertices() {
    let opts = CityJsonOptions { sequence: true, ..CityJsonOptions::default() };
    let out = try_export_cityjson(model("IFC4", MAP_IFC4, Some(false)).as_bytes(), &opts).unwrap();
    let lines: Vec<Value> = out.text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0]["type"], "CityJSON");
    assert!(lines[0]["CityObjects"].as_object().unwrap().is_empty());
    for f in &lines[1..] {
        assert_eq!(f["type"], "CityJSONFeature");
        assert!(f["CityObjects"].as_object().unwrap().contains_key(f["id"].as_str().unwrap()));
        let mut doc = f.clone();
        doc["transform"] = lines[0]["transform"].clone();
        assert_valid(&doc);
    }
    let main = &lines[1..].iter().find(|f| f["id"] == "0Bld0000000000000000B1").unwrap()["CityObjects"];
    assert!(main.as_object().unwrap().contains_key("0Wal0000000000000000W1"));
}

#[test]
fn vertices_are_deduplicated_on_the_grid() {
    let (out, doc) = export(&model("IFC4", MAP_IFC4, None), &CityJsonOptions::default());
    let verts = doc["vertices"].as_array().unwrap();
    let unique: std::collections::HashSet<String> = verts.iter().map(|v| v.to_string()).collect();
    assert_eq!(unique.len(), verts.len());
    assert_eq!(out.vertices, verts.len());
    assert!(verts.iter().all(|v| v.as_array().unwrap().iter().all(|c| c.as_i64().unwrap() >= 0)), "translate is the grid minimum");
}

#[test]
fn a_model_without_buildings_is_refused() {
    let content = model("IFC4", "", None).replace("#61=IFCRELAGGREGATES('0Rel0000000000000000A2',$,$,$,#40,(#41));", "");
    let content = content.replace("#41=IFCBUILDING(", "#41=IFCBUILDINGELEMENTPROXY(").replace(",$,$,.ELEMENT.,$,$,$);\n#42", ",$,$,$);\n#42");
    let err = try_export_cityjson(content.as_bytes(), &CityJsonOptions::default()).unwrap_err();
    assert!(err.reason.contains("no IfcBuilding"), "{err}");
}

#[test]
fn epsg_names() {
    assert_eq!(epsg_code("EPSG:2056"), Some(2056));
    assert_eq!(epsg_code("epsg: 28992"), Some(28992));
    assert_eq!(epsg_code("urn:ogc:def:crs:EPSG::32632"), Some(32632));
    assert_eq!(epsg_code("urn:ogc:def:crs:EPSG:0:2056"), Some(2056), "versioned URN");
    assert_eq!(epsg_code("urn:ogc:def:crs:EPSG:9.9.1:2056"), Some(2056), "versioned URN");
    assert_eq!(epsg_code("http://www.opengis.net/def/crs/EPSG/0/7415"), Some(7415));
    assert_eq!(epsg_code("EPSG:2056+5728"), Some(2056));
    assert_eq!(epsg_code("NC83"), None);
    assert_eq!(epsg_code("EPSG:"), None);
    assert_eq!(epsg_code("EPSG:12ab"), None);
}


/// The most common authoring error: a millimetre project, a metre map unit
/// and no `Scale`. Still local (never inferred), but the warning names both
/// units and the value to set.
#[test]
fn omitted_scale_across_units_names_the_cause_and_the_fix() {
    let unscaled = MAP_IFC4.replace(",0.001);", ",$);");
    let (out, doc) = export(&model("IFC4", &unscaled, None), &CityJsonOptions::default());
    assert!(out.reference_system.is_none(), "never inferred");
    let w = out.warnings.iter().find(|w| w.contains("not georeferenced")).expect("a fallback warning");
    assert!(w.contains("omits Scale"), "{w}");
    assert!(w.contains("project length unit (millimetre, 0.001 m)") && w.contains("map unit (metre, 1 m)"), "{w}");
    assert!(w.contains("set IfcMapConversion.Scale to 0.001"), "{w}");
    assert!(real_vertices(&doc).iter().any(|v| (v[0] - 1.0).abs() < 1e-9 && (v[1] - 2.0).abs() < 1e-9), "local corner");
}

/// With a map unit that is not the metre, every length is in that unit: the
/// coordinates, `measuredHeight` and the storey `Elevation` alike.
#[test]
fn lengths_are_all_in_the_output_unit_when_the_map_unit_is_a_foot() {
    let feet = "#90=IFCPROJECTEDCRS('EPSG:2056',$,'CH1903+','LN02',$,$,#91);\n\
#91=IFCCONVERSIONBASEDUNIT(#93,.LENGTHUNIT.,'FOOT',#94);\n#93=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);\n\
#94=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#95);\n#95=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n\
#92=IFCMAPCONVERSION(#5,#90,2600000.,1200000.,400.,1.,0.,0.0032808398950131233);";
    let (out, doc) = export(&model("IFC4", feet, None), &CityJsonOptions::default());
    assert!(out.reference_system.is_some(), "{:?}", out.warnings);
    let objs = &doc["CityObjects"];
    let height = objs["0Bld0000000000000000B1"]["attributes"]["measuredHeight"].as_f64().unwrap();
    let elevation = objs["0Sty0000000000000000T1"]["attributes"]["Elevation"].as_f64().unwrap();
    // 6 m and 1.5 m in feet (the height on the 0.001 ft grid).
    assert!((height - 6.0 / 0.3048).abs() < 0.001, "measuredHeight {height}");
    assert!((elevation - 1.5 / 0.3048).abs() < 1e-6, "Elevation {elevation} is not in feet");
}

/// Two property sets of one name on one building are merged, not
/// overwritten: the first value wins a conflict and the conflict is reported.
#[test]
fn same_named_property_sets_are_merged_with_a_warning_on_conflict() {
    let extra = "#84=IFCPROPERTYSET('0Pst0000000000000000P5',$,'Pset_BuildingCommon',$,(#85,#86));\n\
#85=IFCPROPERTYSINGLEVALUE('NumberOfStoreys',$,IFCINTEGER(1),$);\n#86=IFCPROPERTYSINGLEVALUE('YearOfConstruction',$,IFCLABEL('2001'),$);\n\
#87=IFCRELDEFINESBYPROPERTIES('0Rel0000000000000000D5',$,$,$,(#41),#84);\n";
    let content = model("IFC4", MAP_IFC4, None).replace("ENDSEC;\nEND-ISO", &format!("{extra}ENDSEC;\nEND-ISO"));
    let (out, doc) = export(&content, &CityJsonOptions::default());
    let set = &doc["CityObjects"]["0Bld0000000000000000B1"]["attributes"]["ifcPropertySets"]["Pset_BuildingCommon"];
    assert_eq!(set["IsLandmarked"], false, "the first set's properties survive");
    assert_eq!(set["NumberOfStoreys"].as_f64(), Some(1.0), "the second set's properties are added");
    assert_eq!(set["YearOfConstruction"], "1984", "the first value in model order wins");
    assert!(
        out.warnings.iter().any(|w| w.contains("0Bld0000000000000000B1") && w.contains("Pset_BuildingCommon.YearOfConstruction")),
        "{:?}",
        out.warnings
    );
}

/// A footprint ring touching itself at a vertex (two lobes meeting at a
/// point) is split into two valid polygons, not dropped.
#[test]
fn a_pinched_footprint_ring_is_split_not_dropped() {
    let ring = vec![[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [4.0, 2.0], [4.0, 4.0], [2.0, 4.0], [2.0, 2.0], [0.0, 2.0]];
    let fp = footprint::Footprint { shapes: vec![vec![ring]], z_min: 0.0, z_max: 3.0, approximated: 0 };
    let id = |p: [f64; 3]| p;
    let mut pool = vertices::VertexPool::new(0.001);
    let mut dropped = 0;
    let g0 = geometry::lod0(&fp, &mut pool, &id, 1e-6, &mut dropped).expect("LoD0 survives the pinch");
    let s0 = surfaces(&g0.value);
    assert_eq!(s0.len(), 2, "two lobes");
    for s in &s0 {
        assert_eq!(s.len(), 1);
        let mut r = s[0].clone();
        r.sort_unstable();
        r.dedup();
        assert_eq!(r.len(), 4, "each lobe visits its four corners once");
    }
    let g1 = geometry::lod1(&fp, &mut pool, &id, 1e-6, &mut dropped).expect("LoD1 survives the pinch");
    assert_eq!(g1.value["type"], "MultiSurface");
    assert_eq!(surfaces(&g1.value).len(), 12, "two boxes of six faces");
    assert_eq!(dropped, 0);
}

/// An island inside a hole cannot be a ring of the polygon; it is counted.
#[test]
fn an_island_inside_a_hole_is_counted_as_dropped() {
    let outer = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
    // A clockwise hole that pinches off a counter-clockwise loop (an island).
    let hole = vec![[2.0, 2.0], [2.0, 8.0], [8.0, 8.0], [5.0, 5.0], [4.0, 4.0], [6.0, 4.0], [5.0, 5.0], [8.0, 2.0]];
    let fp = footprint::Footprint { shapes: vec![vec![outer, hole]], z_min: 0.0, z_max: 3.0, approximated: 0 };
    let mut pool = vertices::VertexPool::new(0.001);
    let mut dropped = 0;
    let g0 = geometry::lod0(&fp, &mut pool, &|p: [f64; 3]| p, 1e-6, &mut dropped).unwrap();
    assert_eq!(surfaces(&g0.value).len(), 1);
    assert_eq!(dropped, 1, "the island");
}

/// A sliver with area in IFC coordinates whose vertices snap to one grid
/// line is no valid surface: it is not written, and it is counted so the
/// caller warns (found by review: the area check read unsnapped positions).
#[test]
fn a_sliver_collinear_on_the_grid_is_dropped_and_counted() {
    let sliver = vec![[0.0, 0.00049], [0.0015, -0.00049], [0.003, 0.00049]];
    let square = vec![[1.0, 0.0], [2.0, 0.0], [2.0, 1.0], [1.0, 1.0]];
    let fp = footprint::Footprint { shapes: vec![vec![sliver], vec![square]], z_min: 0.0, z_max: 3.0, approximated: 0 };
    let mut pool = vertices::VertexPool::new(0.001);
    let mut dropped = 0;
    let g0 = geometry::lod0(&fp, &mut pool, &|p: [f64; 3]| p, 1e-6, &mut dropped).unwrap();
    assert_eq!(surfaces(&g0.value).len(), 1, "only the square is written");
    assert_eq!(dropped, 1, "the sliver is reported");
    let mut dropped1 = 0;
    let g1 = geometry::lod1(&fp, &mut pool, &|p: [f64; 3]| p, 1e-6, &mut dropped1).unwrap();
    assert_eq!(g1.value["type"], "Solid", "one prism, no zero-volume block");
}

/// A small ring far from the origin keeps its area: the shoelace runs
/// relative to a vertex, not on absolute products that cancel (review).
#[test]
fn a_small_ring_at_large_coordinates_is_written() {
    let (x, y, d) = (2_097_152.0, 2_097_152.0, 0.015625);
    let ring = vec![[x, y], [x + d, y], [x + d, y + d], [x, y + d]];
    let fp = footprint::Footprint { shapes: vec![vec![ring]], z_min: 0.0, z_max: 3.0, approximated: 0 };
    let mut pool = vertices::VertexPool::new(0.001);
    let mut dropped = 0;
    let g0 = geometry::lod0(&fp, &mut pool, &|p: [f64; 3]| p, 1e-6, &mut dropped).expect("the ring is written");
    assert_eq!(surfaces(&g0.value).len(), 1);
    assert_eq!(dropped, 0);
}

/// A mesh triangle whose vertices snap onto one grid line is no LoD3
/// surface (review: it was written as a zero-area triangle).
#[test]
fn an_lod3_triangle_collinear_on_the_grid_is_not_written() {
    let positions = vec![0.0, 0.49, 0.0, 1.5, -0.49, 0.0, 3.0, 0.49, 0.0, 0.0, 0.0, 1.0];
    let mesh = MeshData::new(1, "IfcWall".into(), positions, vec![0.0; 12], vec![0, 1, 2, 0, 1, 3], [1.0; 4]);
    let mut pool = vertices::VertexPool::new(1.0);
    let id = |p: [f64; 3]| p;
    let g = geometry::lod3_surfaces(&[&mesh], &id, &mut pool, &id).expect("one real triangle");
    assert_eq!(surfaces(&g.value).len(), 1, "the collinear triangle is dropped, the other kept");
}

/// A 2D 'Model' context beside the 3D one does not make the georeferenced
/// context ambiguous (review: it fell back to local coordinates).
#[test]
fn a_2d_model_context_does_not_block_georeferencing() {
    let content = model("IFC4", MAP_IFC4, None)
        .replace("#7=IFCPROJECT(", "#8=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',2,1.E-05,#4,$);\n#7=IFCPROJECT(");
    let (out, _) = export(&content, &CityJsonOptions::default());
    assert_eq!(out.reference_system.as_deref(), Some("https://www.opengis.net/def/crs/EPSG/0/2056"), "{:?}", out.warnings);
}
