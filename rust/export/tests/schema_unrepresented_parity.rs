// SPDX-License-Identifier: MPL-2.0
//! Rust half of the "no representation in the target schema" pin (#7742).
//!
//! On an IFC4X3 -> IFC4 export the TypeScript converter refused every IFC4X3-only
//! resource record (`IfcCurveSegment`, `IfcClothoid`, ...) while this crate wrote
//! them unchanged under their IFC4X3 names into a file headed `IFC4`; IfcOpenShell
//! drops such records on read, and the references to them then dangle (57 records
//! in Railway_Railway_project_simple_IFC4X3, 7152 in Viadotto_Acerno). Both
//! converters now apply one rule, held to
//! `fixtures/schema_unrepresented_vectors.json`; the TypeScript half is
//! `packages/export/src/schema-unrepresented.parity.test.ts`.

use ifc_lite_export::{export_merged_models, export_step, export_step_json, MergedModel, MergedOptions, StepOptions};

#[derive(serde::Deserialize, Clone)]
struct Case {
    why: String,
    from: String,
    to: String,
    line: String,
    #[serde(default)]
    expect: Option<String>,
    #[serde(default)]
    refuses: bool,
    #[serde(default)]
    merge: bool,
}

fn cases() -> Vec<Case> {
    let raw = include_str!("fixtures/schema_unrepresented_vectors.json");
    let doc: serde_json::Value = serde_json::from_str(raw).expect("fixture is valid JSON");
    serde_json::from_value(doc["cases"].clone()).expect("cases deserialize")
}

fn source(schema: &str, line: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('t','',(''),(''),'','','');\nFILE_SCHEMA(('{}'));\nENDSEC;\n\
         DATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
        schema, line
    )
}

/// Run one entity line through the real exporter, as `ifc-lite export` does.
fn convert(c: &Case) -> Result<String, String> {
    let src = source(&c.from, &c.line);
    let out = export_step_json(src.as_bytes(), Some(c.to.clone()), None, "").map_err(|e| e.to_string())?;
    let line = out.lines().find(|l| l.starts_with('#')).unwrap_or_else(|| panic!("no entity line:\n{out}"));
    // Rust keeps a spaced source's `#5 =` prefix, TS writes `#5=`: cosmetic.
    Ok(line.replacen("#5 =", "#5=", 1))
}

#[test]
fn merging_models_keeps_distinct_proxy_global_ids_11322() {
    for c in cases().into_iter().filter(|c| c.merge) {
        let source = source(&c.from, &c.line);
        let models = ["a", "b"].map(|id| MergedModel { content: source.as_bytes(), id: id.into(), included: None });
        let options = MergedOptions { schema: Some(c.to), ..Default::default() };
        let (merged, _) = export_merged_models(&models, &options);
        let ids: Vec<_> = merged.lines().filter_map(|line| {
            let (_, body) = line.split_once('=')?;
            Some(body.strip_prefix("IFCPROXY('")?.split_once('\'')?.0)
        }).collect();
        assert_eq!(ids.len(), 2, "{}: {merged}", c.why);
        assert!(ids.iter().all(|id| ifc_lite_core::guid::is_valid_global_id(id)), "{ids:?}");
        assert_ne!(ids[0], ids[1], "{}: {merged}", c.why);
        let expected = c.expect.unwrap_or_else(|| panic!("missing expected output for {}", c.why));
        assert!(expected.contains(&format!("IFCPROXY('{}'", ids[0])), "{}: {merged}", c.why);
    }
}

#[test]
fn native_ifc4_proxies_unify_by_global_id_11322() {
    let guid = "0YvctVUKr0kugbFTf53O9L";
    let first = source("IFC4", &format!("#5=IFCPROXY('{guid}',$,'First',$,$,$,$,.NOTDEFINED.,$);"));
    let second = source("IFC4", &format!("#5=IFCPROXY('{guid}',$,'Second',$,$,$,$,.NOTDEFINED.,$);"));
    let models = [("First", &first), ("Second", &second)].map(|(id, content)| MergedModel {
        content: content.as_bytes(), id: id.into(), included: None,
    });
    for schema in ["IFC4", "IFC2X3"] {
        let options = MergedOptions { schema: Some(schema.into()), ..Default::default() };
        let (merged, _) = export_merged_models(&models, &options);
        let proxies: Vec<_> = merged.lines().filter(|line| line.contains("=IFCPROXY(")).collect();
        assert_eq!(proxies.len(), 1, "{schema}: {merged}");
        assert!(proxies[0].contains(&format!("'{guid}'")) && proxies[0].contains("'First'"), "{schema}: {merged}");
    }
}

#[test]
fn generated_proxy_global_id_collision_restamps_the_later_wall_11322() {
    let guid = "3lJWJ4oIi38uI5nMw7H8hx";
    let proxy = source("IFC4X3", "#5=IFCRELPOSITIONS($,$,/* unnamed */$,$,#1,(#2));");
    let wall = source("IFC4", &format!("#1=IFCWALL('{guid}',$,'Wall',$,$,$,$,$,.NOTDEFINED.);"));
    let models = [("proxy", &proxy), ("wall", &wall)].map(|(id, content)| MergedModel {
        content: content.as_bytes(), id: id.into(), included: None,
    });
    let options = MergedOptions { schema: Some("IFC4".into()), ..Default::default() };
    let (merged, _) = export_merged_models(&models, &options);
    assert!(merged.contains(&format!("=IFCPROXY('{guid}'")), "{merged}");
    assert!(merged.contains("=IFCWALL("), "{merged}");
    assert_eq!(merged.matches(&format!("'{guid}'")).count(), 1, "{merged}");
}

#[test]
fn earlier_proxy_does_not_swallow_a_wall_with_the_same_global_id_11322() {
    assert_proxy_wall_collision(false);
}

#[test]
fn earlier_wall_and_later_proxy_keep_distinct_global_ids_11322() {
    assert_proxy_wall_collision(true);
}

fn assert_proxy_wall_collision(wall_first: bool) {
    let guid = "0YvctVUKr0kugbFTf53O9L";
    let proxy = source("IFC4X3", &format!("#5=IFCRELPOSITIONS('{guid}',$,'R',$,#1,(#2));"));
    let wall = source("IFC4", &format!("#1=IFCWALL('{guid}',$,'Wall',$,$,$,$,$,.NOTDEFINED.);"));
    let mut models = [("proxy", &proxy), ("wall", &wall)].map(|(id, content)| MergedModel {
        content: content.as_bytes(), id: id.into(), included: None,
    });
    if wall_first { models.reverse(); }
    let options = MergedOptions { schema: Some("IFC4".into()), ..Default::default() };
    let (merged, _) = export_merged_models(&models, &options);
    let roots: Vec<_> = merged.lines().filter_map(|line| {
        let (_, body) = line.split_once('=')?;
        let (ty, attrs) = body.split_once("('")?;
        matches!(ty, "IFCPROXY" | "IFCWALL").then(|| (ty, attrs.split_once('\'').unwrap().0))
    }).collect();
    let want = if wall_first { ["IFCWALL", "IFCPROXY"] } else { ["IFCPROXY", "IFCWALL"] };
    assert_eq!(roots.iter().map(|(ty, _)| *ty).collect::<Vec<_>>(), want, "{merged}");
    assert_eq!(roots[0].1, guid);
    assert!(ifc_lite_core::guid::is_valid_global_id(roots[1].1));
    assert_ne!(roots[1].1, guid);
}

#[test]
fn walls_and_converted_nonrelationship_proxies_survive_in_both_orders_11322() {
    let guid = "0YvctVUKr0kugbFTf53O9L";
    for (from, to, line, minted_proxy) in [
        ("IFC4", "IFC2X3", format!("#5=IFCSTRUCTURALCURVEREACTION('{guid}',$,'Reaction',$,$,$,$,#2,.GLOBAL_COORDS.,.DISCRETE.);"), false),
        ("IFC4X3", "IFC4", format!("#5=IFCALIGNMENTSEGMENT('{guid}',$,'Segment',$,$,$,$,#2);"), true),
    ] {
        let proxy = source(from, &line);
        let wall = source(from, &format!("#1=IFCWALL('{guid}',$,'Wall',$,$,$,$,$,.NOTDEFINED.);"));
        for wall_first in [true, false] {
            let mut models = [("proxy", &proxy), ("wall", &wall)].map(|(id, content)| MergedModel {
                content: content.as_bytes(), id: id.into(), included: None,
            });
            if wall_first { models.reverse(); }
            let options = MergedOptions { schema: Some(to.into()), ..Default::default() };
            let (merged, _) = export_merged_models(&models, &options);
            let roots: Vec<_> = merged.lines().filter_map(|line| {
                let (_, body) = line.split_once('=')?;
                let (ty, attrs) = body.split_once("('")?;
                matches!(ty, "IFCPROXY" | "IFCWALL").then(|| (ty, attrs.split_once('\'').unwrap().0))
            }).collect();
            let want = if wall_first { ["IFCWALL", "IFCPROXY"] } else { ["IFCPROXY", "IFCWALL"] };
            assert_eq!(roots.iter().map(|(ty, _)| *ty).collect::<Vec<_>>(), want, "{merged}");
            let expected = match (minted_proxy, wall_first) {
                (true, true) => [guid, "2r5SrPtCIW9JYNjX1BW7dv"],
                (true, false) => ["1tUrwBAVKXXziaSy8PtiVv", guid],
                (false, true) => [guid, "10eAHYqx8ewhIsCT7yemIL"],
                (false, false) => [guid, "0tr9wqYqpdsHHEufgQ1Tzr"],
            };
            assert_eq!(roots.iter().map(|(_, id)| *id).collect::<Vec<_>>(), expected, "{merged}");
        }
    }
}

#[test]
fn every_case_agrees_with_the_shared_fixture_7742() {
    let cases = cases();
    assert!(cases.iter().filter(|c| c.refuses).count() >= 8, "anti-vacuity: refusal rows");
    assert!(cases.iter().any(|c| !c.refuses), "anti-vacuity: accepted rows");
    let mut bad = Vec::new();
    // Compact and spaced (`#5 = TYPE (`, as Viadotto_Acerno writes); the TS
    // twin's record regex used to miss the spaced form (#7742).
    let spaced: Vec<Case> = cases
        .iter()
        .map(|c| Case { line: c.line.replacen('=', " = ", 1).replacen('(', " (", 1), ..c.clone() })
        .collect();
    for c in cases.iter().chain(&spaced) {
        let got = convert(c);
        let ok = match (&got, c.refuses) {
            (Err(_), true) => true,
            (Ok(line), false) => Some(line) == c.expect.as_ref(),
            _ => false,
        };
        if !ok {
            bad.push(format!("{} -> {} [{}]\n  in     {}\n  expect {:?}\n  got    {got:?}",
                c.from, c.to, c.why, c.line, if c.refuses { "refusal".to_string() } else { c.expect.clone().unwrap_or_default() }));
        }
    }
    assert!(bad.is_empty(), "{} mismatches:\n{}", bad.len(), bad.join("\n"));
}

#[test]
fn an_upgrade_keeps_the_project_order_as_the_relating_control_10902() {
    let source = include_bytes!("fixtures/ifc2x3-project-order.ifc");
    for schema in ["IFC4", "IFC4X3"] {
        let opts = StepOptions { schema: Some(schema.into()), ..Default::default() };
        let out = export_step(source, &opts).unwrap();
        let order = out.lines().find(|line| line.starts_with("#7=")).unwrap();
        let assignment = out.lines().find(|line| line.starts_with("#8=")).unwrap();
        assert!(order.starts_with("#7=IFCPROJECTORDER(") && order.ends_with(",'PO-7',.PURCHASEORDER.,'Issued',$);"), "{schema}: {order}");
        assert!(assignment.starts_with("#8=IFCRELASSIGNSTOCONTROL(") && assignment.ends_with(",(#6),$,#7);"), "{schema}: {assignment}");
    }
}
