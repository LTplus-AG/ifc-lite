// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C9a-10 (#7784, EDGE-LXPARSE-8): one read of the bytes for every family.
//!
//! `parse_landxml_source` must give exactly what the four single-family entry
//! points give, which are unchanged and still the oracle here.

#[path = "../../export/src/test_support.rs"]
#[allow(dead_code, unused_macros)] // shared with the export unit tests; this file uses `fixture_opt` only
mod test_support;

use ifc_lite_landxml::{
    alignment::{parse_landxml_alignments_optional, LandXmlAlignmentLimits},
    parse_landxml_document, parse_landxml_pipe_networks, parse_landxml_plan, parse_landxml_source,
    parse_landxml_source_with_cancel, parse_landxml_tin, LandXmlDiagnosticCode as Code, LandXmlLimits,
    LandXmlPlanLimits, LandXmlSourceLimits,
};

const NS: &str = "http://www.landxml.org/schema/LandXML-1.2";

fn all_families() -> String {
    format!(
        r#"<LandXML xmlns="{NS}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts><P id="1">0.5 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces><CgPoints><CgPoint name="control">1.25 2 3</CgPoint></CgPoints><Alignments><Alignment name="a" length="1" staStart="0"><CoordGeom><Line><Start>0 0</Start><End>1 0</End></Line></CoordGeom></Alignment></Alignments><PipeNetworks><PipeNetwork name="storm" pipeNetType="storm"><Structs><Struct name="A"><Center>0 0 0</Center><CircStruct diameter="1"/></Struct><Struct name="B"><Center>0 1 0</Center><CircStruct diameter="1"/></Struct></Structs><Pipes><Pipe name="P" refStart="A" refEnd="B"><CircPipe diameter="1"/></Pipe></Pipes></PipeNetwork></PipeNetworks></LandXML>"#
    )
}

fn corpus() -> Vec<(String, Vec<u8>)> {
    let mut corpus = vec![("all families".to_owned(), all_families().into_bytes())];
    for path in [
        "rust/landxml/tests/fixtures/storm-pipe-network.xml",
        "apps/viewer/public/samples/terrain-tin-metric.xml",
    ] {
        let abs = format!("{}/../../{path}", env!("CARGO_MANIFEST_DIR"));
        corpus.push((path.to_owned(), std::fs::read(&abs).unwrap_or_else(|e| panic!("{abs}: {e}"))));
    }
    for path in [
        "landxml/producers/autodesk-civil3d-2020-international-foot-tin.xml",
        "landxml/producers/3d-win-6.6.4-m3-road-alignment.xml",
        "landxml/producers/3d-win-6.6.4-m3-lighting-cgpoints.xml",
        "landxml/producers/aplitop-mdt-8.0-alignment.xml",
        "landxml/producers/bentley-openroads-designer-10.09-us-survey-foot-alignment.xml",
        "landxml/producers/trimble-novapoint-21.354-drainage.xml",
    ] {
        if let Some(bytes) = test_support::fixture_opt(path) {
            corpus.push((path.to_owned(), bytes));
        }
    }
    corpus
}

#[test]
fn one_pass_equals_the_single_family_entry_points() {
    for (name, bytes) in corpus() {
        let source = parse_landxml_source(&bytes);
        let terrain = parse_landxml_tin(&bytes);
        let plan = parse_landxml_plan(&bytes);
        let alignments = parse_landxml_alignments_optional(&bytes);
        let pipes = parse_landxml_pipe_networks(&bytes);
        let separately = match (terrain, plan, alignments) {
            (Ok(mut terrain), Ok(plan), Ok(alignments)) => {
                match &pipes {
                    Ok(pipes) => terrain.pipe_networks = Some(pipes.clone()),
                    Err(error) if error.message == "document contains no PipeNetwork records" => {}
                    Err(error) => panic!("{name}: pipes: {error}"),
                }
                Some((terrain, plan, alignments))
            }
            _ => None,
        };
        match (source, separately) {
            (Ok(source), Some((terrain, plan, alignments))) => {
                assert_eq!(source.document.terrain, terrain, "{name}: terrain");
                assert_eq!(source.document.plan, plan, "{name}: plan");
                assert_eq!(source.alignments, alignments, "{name}: alignments");
                let document = parse_landxml_document(&bytes).unwrap();
                assert_eq!(document, source.document, "{name}: parse_landxml_document");
            }
            (Err(_), None) => {}
            (source, separately) => panic!("{name}: one pass {:?} but separately {:?}", source.err(), separately.is_some()),
        }
    }
}

#[test]
fn the_pipe_family_rides_along_with_explicit_limits() {
    // The wasm `...WithOptions` endpoint used to parse terrain, plan and
    // alignments only; it now returns the pipe networks like the plain one.
    let source = parse_landxml_source_with_cancel(all_families().as_bytes(), &LandXmlSourceLimits::default(), None).unwrap();
    let pipes = source.document.terrain.pipe_networks.expect("pipe networks");
    assert_eq!(pipes.networks.len(), 1);
    assert_eq!(pipes.networks[0].pipes.len(), 1);
    assert_eq!(source.alignments.alignments.len(), 1);
    assert_eq!(source.document.plan.cogo_points().len(), 1);
}

#[test]
fn a_terrain_only_source_has_an_honest_empty_sibling_collection() {
    let (_, bytes) = corpus().remove(2);
    let source = parse_landxml_source(&bytes).unwrap();
    assert!(source.alignments.alignments.is_empty());
    assert!(source.document.terrain.pipe_networks.is_none());
    assert!(!source.document.terrain.surfaces.is_empty());
}

#[test]
fn the_top_level_xml_limits_win_over_the_nested_ones() {
    let tiny = LandXmlLimits { max_work: 1, ..LandXmlLimits::default() };
    let nested_only = LandXmlSourceLimits {
        plan: LandXmlPlanLimits { xml: tiny.clone(), ..Default::default() },
        alignment: LandXmlAlignmentLimits { xml: tiny.clone(), ..Default::default() },
        ..Default::default()
    };
    parse_landxml_source_with_cancel(all_families().as_bytes(), &nested_only, None).unwrap();
    let top_level = LandXmlSourceLimits { xml: tiny, ..Default::default() };
    let refusal = parse_landxml_source_with_cancel(all_families().as_bytes(), &top_level, None).unwrap_err();
    assert_eq!((refusal.code, refusal.message.as_str()), (Code::LimitExceeded, "work limit exceeded"));
}

#[test]
fn record_limits_of_each_family_still_apply() {
    let limits = LandXmlSourceLimits {
        alignment: LandXmlAlignmentLimits { max_alignments: 0, ..Default::default() },
        ..Default::default()
    };
    let refusal = parse_landxml_source_with_cancel(all_families().as_bytes(), &limits, None).unwrap_err();
    assert_eq!((refusal.code, refusal.message.as_str()), (Code::LimitExceeded, "alignment limit exceeded"));
    let limits = LandXmlSourceLimits { plan: LandXmlPlanLimits { max_cogo_points: 0, ..Default::default() }, ..Default::default() };
    let refusal = parse_landxml_source_with_cancel(all_families().as_bytes(), &limits, None).unwrap_err();
    assert_eq!(refusal.message, "CgPoint limit exceeded");
}

#[test]
fn the_terrain_document_does_not_depend_on_the_alignment_family() {
    // `parse_landxml_document` has never parsed horizontal alignments, so a
    // source whose alignment the alignment family refuses still has a terrain
    // document; asking for the alignments (the source) refuses it.
    let bad = all_families().replace("<Start>0 0</Start><End>1 0</End>", "<Start>x y</Start><End>1 0</End>");
    assert!(parse_landxml_document(bad.as_bytes()).is_ok());
    assert!(parse_landxml_tin(bad.as_bytes()).is_ok());
    assert!(parse_landxml_source(bad.as_bytes()).is_err());
}
