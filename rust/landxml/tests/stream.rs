/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use ifc_lite_landxml::{
    alignment::parse_landxml_alignments_optional, parse_landxml_pipe_networks, parse_landxml_plan,
    parse_landxml_tin, LandXmlDiagnosticCode, LandXmlLimits, LandXmlStreamEvent,
    LandXmlSurfaceComponent, LandXmlTinStreamSession, MAX_LANDXML_STREAM_DRAIN_BYTES,
};

const XML: &str = r#"<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces></LandXML>"#;

fn drive(bytes: &[u8], cuts: impl Iterator<Item = usize>) -> Vec<LandXmlStreamEvent> {
    let mut session = LandXmlTinStreamSession::new(LandXmlLimits::default()).expect("session");
    let mut start = 0;
    let mut output = Vec::new();
    for end in cuts {
        session.advance(&bytes[start..end]).expect("advance");
        output.extend(
            session
                .drain(MAX_LANDXML_STREAM_DRAIN_BYTES)
                .expect("drain"),
        );
        start = end;
    }
    if start < bytes.len() {
        session.advance(&bytes[start..]).expect("tail");
        output.extend(
            session
                .drain(MAX_LANDXML_STREAM_DRAIN_BYTES)
                .expect("drain tail"),
        );
    }
    let summary = session.finish().expect("finish");
    assert_eq!(summary.surfaces_drained, 1);
    output.extend(
        session
            .drain(MAX_LANDXML_STREAM_DRAIN_BYTES)
            .expect("final drain"),
    );
    output
}

fn summary_after_byte_cuts(
    bytes: &[u8],
) -> Result<ifc_lite_landxml::LandXmlStreamSummary, ifc_lite_landxml::LandXmlError> {
    let mut session = LandXmlTinStreamSession::new(LandXmlLimits::default())?;
    for byte in bytes {
        session.advance(std::slice::from_ref(byte))?;
    }
    session.finish()
}

const PIPE_NETWORK: &str = r#"<PipeNetworks><PipeNetwork name="storm" pipeNetType="storm"><Structs><Struct name="A"><Center>0 0 0</Center><CircStruct diameter="1"/></Struct><Struct name="B"><Center>0 1 0</Center><CircStruct diameter="1"/></Struct></Structs><Pipes><Pipe name="P" refStart="A" refEnd="B"><CircPipe diameter="1"/></Pipe></Pipes></PipeNetwork></PipeNetworks>"#;

fn landxml(body: &str) -> String {
    format!(
        r#"<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units>{body}</LandXML>"#
    )
}

#[test]
fn issue_5050_arbitrary_utf8_cuts_have_identical_typed_semantics() {
    let bytes = XML.as_bytes();
    let whole = drive(bytes, std::iter::empty());
    let byte_by_byte = drive(bytes, 1..=bytes.len());
    let irregular = drive(bytes, [1, 2, 7, 17, 65, 129, bytes.len() - 1].into_iter());
    assert_eq!(
        serde_json::to_value(&whole).expect("json"),
        serde_json::to_value(&byte_by_byte).expect("json")
    );
    assert_eq!(
        serde_json::to_value(&byte_by_byte).expect("json"),
        serde_json::to_value(&irregular).expect("json")
    );
}

#[test]
fn issue_5050_utf16_code_unit_and_surrogate_cuts_match_utf8() {
    let mut utf16 = vec![0xff, 0xfe];
    utf16.extend(XML.encode_utf16().flat_map(u16::to_le_bytes));
    let utf8 = drive(XML.as_bytes(), std::iter::empty());
    let utf16_events = drive(&utf16, 1..=utf16.len());
    assert_eq!(
        serde_json::to_value(utf8).expect("json"),
        serde_json::to_value(utf16_events).expect("json")
    );
}

#[test]
fn issue_5050_large_single_surface_is_fragmented_not_rejected() {
    let points = (1..=30_000)
        .map(|id| format!("<P id=\"{id}\">{id} {id} 0</P>"))
        .collect::<String>();
    let xml = format!("<LandXML xmlns=\"http://www.landxml.org/schema/LandXML-1.2\" version=\"1.2\"><Units><Metric linearUnit=\"meter\"/></Units><Surfaces><Surface name=\"large\"><Definition surfType=\"TIN\"><Pnts>{points}</Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces></LandXML>");
    let events = drive(xml.as_bytes(), std::iter::empty());
    assert!(events.iter().any(|event| matches!(event, LandXmlStreamEvent::Surface(fragment) if fragment.component == LandXmlSurfaceComponent::Points)));
    assert!(events
        .iter()
        .all(|event| serde_json::to_vec(event).expect("serialize").len()
            <= MAX_LANDXML_STREAM_DRAIN_BYTES));
}

#[test]
fn issue_5050_keeps_security_refusal_precedence_at_chunk_boundaries() {
    let mut session = LandXmlTinStreamSession::new(LandXmlLimits::default()).expect("session");
    let error = session
        .advance(b"<!DOCT")
        .and_then(|_| session.advance(b"YPE LandXML [x]>"))
        .expect_err("doctype refused");
    assert_eq!(error.code, LandXmlDiagnosticCode::DtdForbidden);
}

#[test]
fn issue_5050_mixed_plan_and_alignment_fanout_matches_direct_family_counts() {
    let xml = br#"<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units><CgPoints><CgPoint name="control">0 0 0</CgPoint></CgPoints><Alignments><Alignment name="a" length="1" staStart="0"><CoordGeom><Line><Start>0 0</Start><End>1 0</End></Line></CoordGeom></Alignment></Alignments></LandXML>"#;
    let direct_plan = ifc_lite_landxml::parse_landxml_plan(xml).expect("plan");
    let direct_alignment =
        ifc_lite_landxml::alignment::parse_landxml_alignments_optional(xml).expect("alignment");
    let mut session = LandXmlTinStreamSession::new(LandXmlLimits::default()).expect("session");
    for byte in xml {
        session
            .advance(std::slice::from_ref(byte))
            .expect("byte advance");
    }
    let summary = session.finish().expect("finish");
    assert_eq!(summary.plan_cogo_points, direct_plan.cogo_points().len());
    assert_eq!(
        summary.horizontal_alignments,
        direct_alignment.alignments.len()
    );
}

#[test]
fn issue_5050_pipe_only_stream_matches_direct_pipe_document() {
    let xml = landxml(PIPE_NETWORK);
    let direct = parse_landxml_pipe_networks(xml.as_bytes()).expect("direct pipe document");
    let summary = summary_after_byte_cuts(xml.as_bytes()).expect("stream pipe document");
    assert_eq!(summary.pipe_networks, direct.networks.len());
    assert_eq!(
        summary.pipe_structures,
        direct
            .networks
            .iter()
            .map(|network| network.structures.len())
            .sum::<usize>()
    );
    assert_eq!(
        summary.pipes,
        direct
            .networks
            .iter()
            .map(|network| network.pipes.len())
            .sum::<usize>()
    );
    assert_eq!(summary.pipe_refusals, direct.refusals.len());
}

#[test]
fn issue_5050_all_family_stream_matches_direct_semantic_totals() {
    let xml = landxml(&format!(
        r#"<Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces><CgPoints><CgPoint name="control">0 0 0</CgPoint></CgPoints><Alignments><Alignment name="a" length="1" staStart="0"><CoordGeom><Line><Start>0 0</Start><End>1 0</End></Line></CoordGeom></Alignment></Alignments>{PIPE_NETWORK}"#
    ));
    let terrain = parse_landxml_tin(xml.as_bytes()).expect("direct terrain document");
    let plan = parse_landxml_plan(xml.as_bytes()).expect("direct plan document");
    let alignment =
        parse_landxml_alignments_optional(xml.as_bytes()).expect("direct alignment document");
    let pipe = parse_landxml_pipe_networks(xml.as_bytes()).expect("direct pipe document");
    let summary = summary_after_byte_cuts(xml.as_bytes()).expect("stream all-family document");
    assert_eq!(summary.surfaces_drained, terrain.surfaces.len());
    assert_eq!(summary.plan_cogo_points, plan.cogo_points().len());
    assert_eq!(summary.horizontal_alignments, alignment.alignments.len());
    assert_eq!(summary.pipe_networks, pipe.networks.len());
    assert_eq!(
        summary.pipe_structures,
        pipe.networks
            .iter()
            .map(|network| network.structures.len())
            .sum::<usize>()
    );
    assert_eq!(
        summary.pipes,
        pipe.networks
            .iter()
            .map(|network| network.pipes.len())
            .sum::<usize>()
    );
}

#[test]
fn issue_5050_pipe_stream_keeps_direct_malformed_and_semantic_error_codes() {
    let malformed = landxml("<PipeNetworks>");
    assert_eq!(
        summary_after_byte_cuts(malformed.as_bytes())
            .expect_err("stream malformed XML")
            .code,
        parse_landxml_pipe_networks(malformed.as_bytes())
            .expect_err("direct malformed XML")
            .code
    );
    let invalid_type =
        landxml(&PIPE_NETWORK.replace("pipeNetType=\"storm\"", "pipeNetType=\"bogus\""));
    assert_eq!(
        summary_after_byte_cuts(invalid_type.as_bytes())
            .expect_err("stream invalid pipe type")
            .code,
        parse_landxml_pipe_networks(invalid_type.as_bytes())
            .expect_err("direct invalid pipe type")
            .code
    );
}
