// SPDX-License-Identifier: MPL-2.0
//! Rust half of the IfcGridPlacement pin (#9026 item 14). TypeScript half:
//! `packages/export/src/schema-grid-frames.parity.test.ts`.

use ifc_lite_export::export_step_json;

#[derive(serde::Deserialize)]
struct Case {
    why: String,
    from: String,
    to: String,
    records: Vec<String>,
    expect: Vec<String>,
}

fn export(from: &str, to: &str, records: &[String]) -> Result<String, String> {
    let src = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('t','',(''),(''),'','','');\nFILE_SCHEMA(('{from}'));\nENDSEC;\nDATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
        records.join("\n")
    );
    export_step_json(src.as_bytes(), Some(to.to_string()), None, "").map_err(|e| e.to_string())
}

#[test]
fn every_case_agrees_with_the_shared_fixture() {
    let doc: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/schema_grid_placement_vectors.json")).expect("valid JSON");
    let cases: Vec<Case> = serde_json::from_value(doc["cases"].clone()).expect("cases");
    assert!(cases.len() >= 8, "anti-vacuity");
    for c in &cases {
        let out = export(&c.from, &c.to, &c.records).unwrap_or_else(|e| panic!("{} -> {} [{}]: {e}", c.from, c.to, c.why));
        let written: Vec<&str> = out.lines().filter(|l| l.starts_with('#')).collect();
        assert_eq!(written, c.expect, "{} -> {} [{}]", c.from, c.to, c.why);
    }
}

/// A column on a crossing of a grid at (10,20,3), offset (4,5) from its axes:
/// conversion must not move it. `$` in IFC4X3 would put it in the world frame.
#[test]
fn a_column_on_an_off_origin_grid_stays_where_it_is_across_conversion() {
    use ifc_lite_core::{build_entity_index, EntityDecoder};
    let records = [
        "#8=IFCCARTESIANPOINT((0.,0.,0.));",
        "#9=IFCAXIS2PLACEMENT3D(#8,$,$);",
        "#20=IFCCARTESIANPOINT((10.,20.,3.));",
        "#21=IFCAXIS2PLACEMENT3D(#20,$,$);",
        "#22=IFCLOCALPLACEMENT($,#21);",
        "#30=IFCCARTESIANPOINT((0.,0.));",
        "#31=IFCCARTESIANPOINT((12.,0.));",
        "#32=IFCCARTESIANPOINT((0.,8.));",
        "#33=IFCPOLYLINE((#30,#31));",
        "#34=IFCPOLYLINE((#30,#32));",
        "#35=IFCGRIDAXIS('1',#34,.T.);",
        "#36=IFCGRIDAXIS('A',#33,.T.);",
        "#40=IFCGRID('1YvctVUKr0kugbFTf53O9L',$,$,$,$,#22,$,(#35),(#36),$,.NOTDEFINED.);",
        "#50=IFCVIRTUALGRIDINTERSECTION((#35,#36),(4.,5.,0.));",
        "#51=IFCGRIDPLACEMENT(#50,$);",
        "#54=IFCLOCALPLACEMENT(#51,#9);",
    ]
    .map(str::to_string);
    let source = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('t','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
        records.join("\n")
    );
    let converted = export("IFC4", "IFC4X3", &records).expect("export");
    let origin = |content: &str| {
        let index = build_entity_index(content);
        let mut decoder = EntityDecoder::with_index(content, index);
        let placement = decoder.decode_by_id(54).expect("column placement");
        let m = ifc_lite_geometry::placement::resolve_chain(&placement, &mut decoder).expect("resolves");
        [m[(0, 3)], m[(1, 3)], m[(2, 3)]]
    };
    let (before, after) = (origin(&source), origin(&converted));
    assert_eq!(before, after, "the converted column moved\n{converted}");
    assert!(before[2] == 3.0 && (before[0] - 10.0).abs() > 1.0, "the grid frame must matter here: {before:?}");
}

fn log_export(records: &[&str], log: &str) -> String {
    let source = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('t','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
        records.join("\n")
    );
    let log = ifc_lite_export::MutationLog::from_json(log).expect("log");
    let opts = ifc_lite_export::StepOptions { schema: Some("IFC4X3".into()), ..Default::default() };
    ifc_lite_export::export_step_with_log(source.as_bytes(), &opts, &log).expect("exports").0
}

const GRID: &str = "#20=IFCGRID('2$abcdefghijklmnopqrst1',$,$,$,$,#10,$,(#1),(#2),$,.NOTDEFINED.);";
const CROSSING: &str = "#30=IFCVIRTUALGRIDINTERSECTION((#1,#2),(0.,0.,0.));";

/// The session path: a placement the log created, on a source grid, and one the
/// log created together with its grid (#9026 item 14).
#[test]
fn a_log_created_placement_names_the_owning_grid() {
    let out = log_export(
        &[GRID, CROSSING],
        r##"{"mutations":[{"type":"CREATE_ENTITY","entityId":40,"attributeName":"IfcGridPlacement"}],
            "newEntities":[{"expressId":40,"type":"IfcGridPlacement","attributes":["#30",null]}]}"##,
    );
    assert!(out.contains("#40=IFCGRIDPLACEMENT(#10,#30,$);"), "{out}");

    let out = log_export(
        &[],
        r##"{"mutations":[{"type":"CREATE_ENTITY","entityId":40,"attributeName":"IfcGridPlacement"},
                         {"type":"CREATE_ENTITY","entityId":30,"attributeName":"IfcVirtualGridIntersection"},
                         {"type":"CREATE_ENTITY","entityId":20,"attributeName":"IfcGrid"}],
            "newEntities":[{"expressId":40,"type":"IfcGridPlacement","attributes":["#30",null]},
                           {"expressId":30,"type":"IfcVirtualGridIntersection","attributes":[["#1","#2"],[0.0,0.0,0.0]]},
                           {"expressId":20,"type":"IfcGrid","attributes":["2$abcdefghijklmnopqrst1",null,null,null,null,"#10",null,["#1"],["#2"],null,null]}]}"##,
    );
    assert!(out.contains("#40=IFCGRIDPLACEMENT(#10,#30,$);"), "{out}");
}

/// A grid the log deleted has no placement left to name: its frame would dangle.
#[test]
fn a_deleted_grid_is_not_named() {
    let out = log_export(
        &[GRID, CROSSING, "#40=IFCGRIDPLACEMENT(#30,$);"],
        r##"{"mutations":[{"type":"DELETE_ENTITY","entityId":20}]}"##,
    );
    assert!(!out.contains("IFCGRID("), "{out}");
    assert!(out.contains("#40=IFCGRIDPLACEMENT($,#30,$);"), "{out}");
}
