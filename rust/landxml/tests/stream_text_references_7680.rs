/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! #7680 EDGE-LXPARSE-3: one text token that quick-xml reports as several
//! events (`1&#46;5` is Text, GeneralRef, Text) must not desynchronise the
//! streaming session, and the stream must agree with the pull parsers on
//! the same bytes, for both accepted values and refusal codes.

use ifc_lite_landxml::{
    alignment::parse_landxml_alignments_optional, parse_landxml_document,
    parse_landxml_pipe_networks, parse_landxml_tin_with_cancel, LandXmlDiagnosticCode,
    LandXmlError, LandXmlLimits, LandXmlStreamEvent, LandXmlStreamSummary, LandXmlSurfaceComponent,
    LandXmlTinStreamSession, MAX_LANDXML_STREAM_DRAIN_BYTES,
};
use serde_json::Value;

/// The same all-family source as `text_references_7680.rs`, inlined so each
/// test binary stands alone. Every text capture carries a reference.
const REFERENCED: &str = r#"<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts><P id="1">0&#46;5 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1&#32;2&#x20;3</F></Faces></Definition></Surface></Surfaces><CgPoints><CgPoint name="control">1&#x2E;25 2 3</CgPoint></CgPoints><Alignments><Alignment name="a" length="1" staStart="0"><CoordGeom><Line><Start>0 0</Start><End>1&#46;0 0</End></Line></CoordGeom></Alignment></Alignments><PipeNetworks><PipeNetwork name="storm" pipeNetType="storm"><Structs><Struct name="A"><Center>0 0 0</Center><CircStruct diameter="1"/></Struct><Struct name="B"><Center>0 1&#46;0 0</Center><CircStruct diameter="1"/></Struct></Structs><Pipes><Pipe name="P" refStart="A" refEnd="B"><CircPipe diameter="1"/></Pipe></Pipes></PipeNetwork></PipeNetworks></LandXML>"#;

fn literal() -> String {
    REFERENCED
        .replace("&#46;", ".")
        .replace("&#x2E;", ".")
        .replace("&#32;", " ")
        .replace("&#x20;", " ")
}

/// Stream `bytes` in chunks of `chunk` bytes, draining as the host would.
fn stream(
    bytes: &[u8],
    chunk: usize,
    limits: LandXmlLimits,
) -> Result<(Vec<LandXmlStreamEvent>, LandXmlStreamSummary), LandXmlError> {
    let mut session = LandXmlTinStreamSession::new(limits)?;
    let mut events = Vec::new();
    for piece in bytes.chunks(chunk) {
        drain(&mut session, &mut events)?;
        session.advance(piece)?;
        drain(&mut session, &mut events)?;
    }
    drain(&mut session, &mut events)?;
    let summary = session.finish()?;
    Ok((events, summary))
}

fn drain(
    session: &mut LandXmlTinStreamSession,
    events: &mut Vec<LandXmlStreamEvent>,
) -> Result<(), LandXmlError> {
    while session.output_pending() {
        events.extend(session.drain(MAX_LANDXML_STREAM_DRAIN_BYTES)?);
    }
    Ok(())
}

/// Reassemble the streamed surface points, which arrive one JSON value per
/// (possibly continued) `Points` fragment.
fn streamed_points(events: &[LandXmlStreamEvent]) -> Vec<Value> {
    let mut points = Vec::new();
    let mut pending = Vec::new();
    for event in events {
        let LandXmlStreamEvent::Surface(fragment) = event else {
            continue;
        };
        if fragment.component != LandXmlSurfaceComponent::Points {
            continue;
        }
        pending.extend_from_slice(&fragment.payload_utf8);
        if !fragment.continued {
            points.push(serde_json::from_slice(&pending).expect("point JSON"));
            pending.clear();
        }
    }
    points
}

fn json(value: &impl serde::Serialize) -> Value {
    serde_json::to_value(value).expect("serializable")
}

#[test]
fn issue_7680_edge_lxparse_3_stream_matches_pull_on_text_references() {
    let bytes = REFERENCED.as_bytes();
    let direct = parse_landxml_document(bytes).expect("direct document");
    let alignments = parse_landxml_alignments_optional(bytes).expect("direct alignments");
    let pipes = parse_landxml_pipe_networks(bytes).expect("direct pipes");
    assert_eq!(direct.terrain.surfaces[0].points[0].northing, 0.5);
    for chunk in [bytes.len(), 7, 1] {
        let (events, summary) =
            stream(bytes, chunk, LandXmlLimits::default()).expect("stream document");
        assert_eq!(
            streamed_points(&events),
            json(&direct.terrain.surfaces[0].points)
                .as_array()
                .expect("points array")
                .clone(),
            "chunk {chunk}: streamed points"
        );
        let mut terrain = direct.terrain.clone();
        terrain.surfaces.clear();
        assert_eq!(summary.metadata.terrain, terrain, "chunk {chunk}: terrain");
        assert_eq!(summary.metadata.plan, direct.plan, "chunk {chunk}: plan");
        assert_eq!(summary.metadata.alignments, alignments, "chunk {chunk}");
        assert_eq!(summary.pipe_networks, pipes.networks.len());
        assert_eq!(summary.pipe_refusals, pipes.refusals.len());
    }
}

#[test]
fn issue_7680_edge_lxparse_3_stream_resolves_references_like_literal_text() {
    let literal = literal();
    for chunk in [REFERENCED.len(), 5, 1] {
        let (referenced_events, referenced) =
            stream(REFERENCED.as_bytes(), chunk, LandXmlLimits::default()).expect("referenced");
        let (literal_events, plain) =
            stream(literal.as_bytes(), chunk, LandXmlLimits::default()).expect("literal");
        assert_eq!(json(&referenced_events), json(&literal_events), "{chunk}");
        assert_eq!(json(&referenced), json(&plain), "chunk {chunk}");
    }
}

#[test]
fn issue_7680_edge_lxparse_3_stream_refuses_what_pull_refuses() {
    let literal = literal();
    let cases = [
        (
            "undeclared entity",
            REFERENCED.replace("0&#46;5", "0&custom;5"),
        ),
        ("reference before root", format!("&#32;{literal}")),
        ("reference after root", format!("{literal}&#32;")),
        ("entity after root", format!("{literal}&amp;")),
        (
            "entity in a face",
            literal.replace("<F>1 2 3", "<F>1 2 3&amp;"),
        ),
    ];
    let mut mismatches = Vec::new();
    for (name, xml) in &cases {
        let pull = parse_landxml_tin_with_cancel(xml.as_bytes(), &LandXmlLimits::default(), None)
            .map(|_| ())
            .map_err(|error| error.code);
        if pull.is_ok() {
            mismatches.push(format!("{name}: pull accepted it"));
        }
        for chunk in [xml.len(), 1] {
            let streamed = stream(xml.as_bytes(), chunk, LandXmlLimits::default())
                .map(|_| ())
                .map_err(|error| error.code);
            if streamed != pull {
                mismatches.push(format!(
                    "{name} chunk {chunk}: {streamed:?} vs pull {pull:?}"
                ));
            }
        }
    }
    assert!(mismatches.is_empty(), "{mismatches:#?}");
}

#[test]
fn issue_7680_edge_lxparse_3_stream_charges_text_references_to_the_cap() {
    let total = REFERENCED.matches('&').count();
    let at_cap = LandXmlLimits {
        max_character_references: total,
        ..LandXmlLimits::default()
    };
    stream(REFERENCED.as_bytes(), 1, at_cap).expect("at the cap");
    let below_cap = LandXmlLimits {
        max_character_references: total - 1,
        ..LandXmlLimits::default()
    };
    let pull = parse_landxml_tin_with_cancel(REFERENCED.as_bytes(), &below_cap, None)
        .expect_err("pull below the cap");
    let streamed = stream(REFERENCED.as_bytes(), 1, below_cap).expect_err("stream below cap");
    assert_eq!(pull.code, LandXmlDiagnosticCode::LimitExceeded);
    assert_eq!(streamed.code, pull.code);
}
