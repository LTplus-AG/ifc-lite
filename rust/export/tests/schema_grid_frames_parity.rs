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

fn source(from: &str, records: &[String]) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('t','',(''),(''),'','','');\nFILE_SCHEMA(('{from}'));\nENDSEC;\nDATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
        records.join("\n")
    )
}

/// Every product's placement, by the geometry reader; `None` where it does not resolve.
fn product_frames(content: &str) -> Vec<(u32, Option<[f64; 16]>)> {
    use ifc_lite_core::{build_entity_index, EntityDecoder};
    let index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, index);
    let products: Vec<u32> = content
        .lines()
        .filter(|l| ["=IFCCOLUMN(", "=IFCSITE(", "=IFCBUILDING("].iter().any(|t| l.contains(t)))
        .filter_map(|l| l.strip_prefix('#')?.split('=').next()?.parse().ok())
        .collect();
    products
        .into_iter()
        .map(|id| {
            let frame = decoder.decode_by_id(id).ok().and_then(|p| p.get_ref(5)).and_then(|placement| {
                let placement = decoder.decode_by_id(placement).ok()?;
                let m = ifc_lite_geometry::placement::resolve_chain(&placement, &mut decoder).ok()?;
                Some(std::array::from_fn(|i| m[(i % 4, i / 4)]))
            });
            (id, frame)
        })
        .collect()
}

/// #9209: the IFC2X3 pass moves no product. Each case's products resolve, by
/// the geometry reader, to the same frame before and after the export.
#[test]
fn ifc2x3_output_keeps_every_product_where_the_reader_put_it() {
    let doc: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/schema_grid_placement_vectors.json")).expect("valid JSON");
    let cases: Vec<Case> = serde_json::from_value(doc["cases"].clone()).expect("cases");
    let mut compared = 0;
    for c in cases.iter().filter(|c| c.to == "IFC2X3") {
        let before = source(&c.from, &c.records);
        let after = export(&c.from, &c.to, &c.records).expect("export");
        let after = product_frames(&after);
        for (id, frame) in product_frames(&before) {
            let Some(frame) = frame else { continue };
            let moved = after.iter().find(|(a, _)| *a == id).and_then(|(_, f)| *f).expect("still placed");
            assert!(frame.iter().zip(moved).all(|(a, b)| (a - b).abs() < 1e-9), "#{id} moved [{}]: {frame:?} -> {moved:?}", c.why);
            compared += 1;
        }
    }
    assert!(compared >= 12, "anti-vacuity: {compared} products compared");
}

/// The log writer, the streaming writer and the merged writer adapt IFC2X3 output too.
#[test]
fn every_step_writer_places_one_product_per_placement_in_ifc2x3() {
    let doc: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/schema_grid_placement_vectors.json")).expect("valid JSON");
    let cases: Vec<Case> = serde_json::from_value(doc["cases"].clone()).expect("cases");
    let c = cases.iter().find(|c| c.from == "IFC4" && c.to == "IFC2X3").expect("an IFC4 -> IFC2X3 case");
    let content = source(&c.from, &c.records);
    let records = |out: &str| out.lines().filter(|l| l.starts_with('#')).map(str::to_string).collect::<Vec<_>>();
    let opts = ifc_lite_export::StepOptions { schema: Some("IFC2X3".into()), ..Default::default() };

    let log = ifc_lite_export::MutationLog::from_json(r#"{"mutations":[]}"#).expect("log");
    let (logged, stats) = ifc_lite_export::export_step_with_log(content.as_bytes(), &opts, &log).expect("log export");
    // The log writer writes source records in id order, the TypeScript exporter's.
    let sorted = |mut v: Vec<String>| {
        v.sort();
        v
    };
    assert_eq!(sorted(records(&logged)), sorted(c.expect.clone()), "log writer");
    assert_eq!(stats.written, c.expect.len(), "the log writer counts what it wrote");

    let mut streamed = Vec::new();
    let stats = ifc_lite_export::export_step_to_writer(content.as_bytes(), &opts, &mut streamed).expect("stream");
    assert_eq!(records(&String::from_utf8(streamed).expect("UTF-8")), c.expect, "streaming writer");
    assert_eq!(stats.written, c.expect.len(), "the streaming writer counts what it wrote");

    let merged_opts = ifc_lite_export::MergedOptions { schema: Some("IFC2X3".into()), ..Default::default() };
    let (merged, _) = ifc_lite_export::export_merged_with_stats(&[content.as_bytes()], &merged_opts);
    assert_eq!(placed_by(&merged).values().map(Vec::len).collect::<Vec<_>>(), [1, 1, 1], "merged writer:\n{merged}");
}

/// Each placement of `out`, with the records naming it as their `ObjectPlacement`.
fn placed_by(out: &str) -> std::collections::BTreeMap<u32, Vec<u32>> {
    let record = |l: &str| -> Option<(u32, String, Vec<String>)> {
        let (id, rest) = l.strip_prefix('#')?.split_once('=')?;
        let (ty, args) = rest.split_once('(')?;
        let (mut slots, mut depth, mut quoted, mut cur) = (Vec::new(), 0, false, String::new());
        for ch in args.trim_end_matches(';').strip_suffix(')')?.chars() {
            match ch {
                '\'' => quoted = !quoted,
                '(' if !quoted => depth += 1,
                ')' if !quoted => depth -= 1,
                ',' if !quoted && depth == 0 => {
                    slots.push(std::mem::take(&mut cur));
                    continue;
                }
                _ => {}
            }
            cur.push(ch);
        }
        slots.push(cur);
        Some((id.parse().ok()?, ty.to_string(), slots))
    };
    let records: Vec<_> = out.lines().filter_map(record).collect();
    let is_placement = |ty: &str| ty == "IFCLOCALPLACEMENT" || ty == "IFCGRIDPLACEMENT";
    let mut placed: std::collections::BTreeMap<u32, Vec<u32>> =
        records.iter().filter(|r| is_placement(&r.1)).map(|r| (r.0, Vec::new())).collect();
    for (id, _, slots) in records.iter().filter(|r| !is_placement(&r.1)) {
        let named = slots.get(5).and_then(|s| s.strip_prefix('#')?.parse::<u32>().ok());
        if let Some(list) = named.and_then(|p| placed.get_mut(&p)) {
            list.push(*id);
        }
    }
    placed
}
