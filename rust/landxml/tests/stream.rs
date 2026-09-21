/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use ifc_lite_landxml::{
    alignment::parse_landxml_alignments_optional, parse_landxml_document,
    parse_landxml_pipe_networks, parse_landxml_plan, parse_landxml_tin,
    parse_landxml_tin_with_cancel, LandXmlDiagnosticCode, LandXmlError, LandXmlLimits,
    LandXmlMetadataRecord, LandXmlMetadataStreamEvent, LandXmlStreamEvent, LandXmlStreamSummary,
    LandXmlSurfaceComponent, LandXmlTinStreamSession, MAX_LANDXML_STREAM_DRAIN_BYTES,
    MAX_LANDXML_STREAM_EVENT_BYTES, MAX_LANDXML_STREAM_QUEUED_BYTES,
    MAX_LANDXML_STREAM_QUEUED_EVENTS,
};

const XML: &str = r#"<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces></LandXML>"#;
const XML_WITHOUT_UNITS: &str = r#"<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Surfaces><Surface name="survey-only"><Definition surfType="VOLUME"/></Surface></Surfaces></LandXML>"#;

fn drive(bytes: &[u8], cuts: impl Iterator<Item = usize>) -> Vec<LandXmlStreamEvent> {
    let mut session = LandXmlTinStreamSession::new(LandXmlLimits::default()).expect("session");
    let mut start = 0;
    let mut output = Vec::new();
    for end in cuts {
        advance_and_drain(&mut session, &bytes[start..end], &mut output);
        start = end;
    }
    if start < bytes.len() {
        advance_and_drain(&mut session, &bytes[start..], &mut output);
    }
    let summary = session.finish().expect("finish");
    assert_eq!(summary.surfaces_drained, 1);
    drain_until_idle(&mut session, &mut output);
    output
}

fn advance_and_drain(
    session: &mut LandXmlTinStreamSession,
    chunk: &[u8],
    output: &mut Vec<LandXmlStreamEvent>,
) {
    drain_until_idle(session, output);
    session.advance(chunk).expect("advance");
    drain_until_idle(session, output);
}

fn drain_until_idle(session: &mut LandXmlTinStreamSession, output: &mut Vec<LandXmlStreamEvent>) {
    while session.output_pending() {
        let events = session
            .drain(MAX_LANDXML_STREAM_DRAIN_BYTES)
            .expect("drain");
        assert!(!events.is_empty(), "pending output must consume credit");
        output.extend(events);
    }
}

fn summary_after_byte_cuts(bytes: &[u8]) -> Result<LandXmlStreamSummary, LandXmlError> {
    summary_after_byte_cuts_with_limits(bytes, LandXmlLimits::default())
}

fn summary_after_byte_cuts_with_limits(
    bytes: &[u8],
    limits: LandXmlLimits,
) -> Result<LandXmlStreamSummary, LandXmlError> {
    let mut session = LandXmlTinStreamSession::new(limits)?;
    let mut ignored = Vec::new();
    for byte in bytes {
        drain_until_idle_result(&mut session, &mut ignored)?;
        session.advance(std::slice::from_ref(byte))?;
        drain_until_idle_result(&mut session, &mut ignored)?;
    }
    drain_until_idle_result(&mut session, &mut ignored)?;
    session.finish()
}

fn drain_until_idle_result(
    session: &mut LandXmlTinStreamSession,
    output: &mut Vec<LandXmlStreamEvent>,
) -> Result<(), LandXmlError> {
    while session.output_pending() {
        let events = session.drain(MAX_LANDXML_STREAM_DRAIN_BYTES)?;
        assert!(!events.is_empty(), "pending output must consume credit");
        output.extend(events);
    }
    Ok(())
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
fn issue_5161_stream_preserves_a_unitless_volume_document() {
    let direct =
        parse_landxml_tin(XML_WITHOUT_UNITS.as_bytes()).expect("direct preserved-only source");
    let summary = summary_after_byte_cuts(XML_WITHOUT_UNITS.as_bytes())
        .expect("stream preserved-only source");
    assert!(direct.units.is_none());
    assert_eq!(direct.capabilities.preserved_only_surfaces, 1);
    assert!(summary.header.units.is_none());
    assert_eq!(summary.preserved_surfaces, 1);
    assert!(summary.metadata.terrain.units.is_none());
}

#[test]
fn issue_5050_accepts_leading_interior_and_trailing_comments_across_chunks() {
    let xml = r#"<!--leading--><?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><!--between-root-and-units--><Units><!--inside-units--><Metric linearUnit="meter"/></Units><!--before-surfaces--><Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><!--between-topology--><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces></LandXML><!--trailing-->"#;
    let direct = parse_landxml_tin(xml.as_bytes()).expect("direct comments");
    let events = drive(xml.as_bytes(), 1..=xml.len());
    assert!(events.iter().any(
        |event| matches!(event, LandXmlStreamEvent::Surface(fragment) if fragment.component == LandXmlSurfaceComponent::End)
    ));
    let summary = summary_after_byte_cuts(xml.as_bytes()).expect("stream comments");
    assert_eq!(summary.surfaces_drained, direct.surfaces.len());
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
fn issue_5050_stream_requires_credit_and_never_retains_unbounded_transport() {
    let points = (1..=30_000)
        .map(|id| format!("<P id=\"{id}\">{id} {id} 0</P>"))
        .collect::<String>();
    let xml = format!("<LandXML xmlns=\"http://www.landxml.org/schema/LandXML-1.2\" version=\"1.2\"><Units><Metric linearUnit=\"meter\"/></Units><Surfaces><Surface name=\"large\"><Definition surfType=\"TIN\"><Pnts>{points}</Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces></LandXML>");
    let mut session = LandXmlTinStreamSession::new(LandXmlLimits::default()).expect("session");
    session.advance(xml.as_bytes()).expect("initial input");
    assert!(
        session.output_pending(),
        "units header grants the first credit stop"
    );
    assert_eq!(
        session
            .advance(&[])
            .expect_err("no source past missing credit")
            .code,
        LandXmlDiagnosticCode::LimitExceeded
    );

    let mut fragments = 0;
    let mut peak_events = 0;
    while session.output_pending() {
        assert!(session.queued_bytes() <= MAX_LANDXML_STREAM_QUEUED_BYTES);
        assert!(session.queued_events() <= MAX_LANDXML_STREAM_QUEUED_EVENTS);
        peak_events = peak_events.max(session.queued_events());
        let events = session
            .drain(MAX_LANDXML_STREAM_DRAIN_BYTES)
            .expect("credit drain");
        assert!(
            !events.is_empty(),
            "every pending state returns credited data"
        );
        assert!(events.iter().all(|event| {
            serde_json::to_vec(event)
                .expect("serialize bounded event")
                .len()
                <= MAX_LANDXML_STREAM_EVENT_BYTES
        }));
        fragments += events.len();
    }
    assert_eq!(peak_events, MAX_LANDXML_STREAM_QUEUED_EVENTS);
    assert!(
        fragments > 4,
        "large surface needed repeated credited drains"
    );
    session
        .finish()
        .expect("complete after all credit is returned");
}

#[test]
fn issue_5050_huge_plan_end_stays_credited_and_abandonment_releases_it() {
    let points = (1..=12_000)
        .map(|ordinal| format!("<CgPoint name=\"p{ordinal}\">{ordinal} 0 0</CgPoint>"))
        .collect::<String>();
    let xml = landxml(&format!("<CgPoints>{points}</CgPoints>"));
    let mut session = LandXmlTinStreamSession::new(LandXmlLimits::default()).expect("session");
    session.advance(xml.as_bytes()).expect("source input");
    while session.output_pending() {
        session
            .drain(MAX_LANDXML_STREAM_DRAIN_BYTES)
            .expect("source credit");
    }
    session.finish_cursor().expect("metadata cursor");
    let mut peak_queued = 0;
    let mut saw_derived = false;
    let mut end_bytes = None;
    while session.output_pending() {
        peak_queued = peak_queued.max(session.queued_bytes());
        assert!(session.queued_bytes() <= MAX_LANDXML_STREAM_QUEUED_BYTES);
        let events = session.drain(512 * 1024).expect("exact host credit");
        let emitted = events
            .iter()
            .map(|event| serde_json::to_vec(event).expect("event JSON").len())
            .sum::<usize>();
        assert!(emitted <= 512 * 1024, "one drain cannot exceed host credit");
        for event in events {
            if let LandXmlStreamEvent::Metadata(metadata) = event {
                match metadata.as_ref() {
                    LandXmlMetadataStreamEvent::Record(record)
                        if matches!(record.as_ref(), LandXmlMetadataRecord::PlanSourceBatch(_)) =>
                    {
                        saw_derived = true;
                    }
                    LandXmlMetadataStreamEvent::End(_) => {
                        end_bytes = Some(
                            serde_json::to_vec(metadata.as_ref())
                                .expect("End JSON")
                                .len(),
                        )
                    }
                    _ => {}
                }
            }
        }
    }
    assert!(peak_queued > 0 && saw_derived);
    assert!(
        end_bytes.expect("End emitted") < 1024,
        "End is counters-only"
    );

    let mut abandoned = LandXmlTinStreamSession::new(LandXmlLimits::default()).expect("session");
    abandoned.advance(xml.as_bytes()).expect("source input");
    while abandoned.output_pending() {
        abandoned
            .drain(MAX_LANDXML_STREAM_DRAIN_BYTES)
            .expect("source credit");
    }
    abandoned.finish_cursor().expect("metadata cursor");
    assert!(
        abandoned.output_pending(),
        "large plan owns cursor records before the next credit"
    );
    abandoned.abort();
    assert!(!abandoned.output_pending());
    assert_eq!(abandoned.queued_bytes(), 0);
    assert_eq!(abandoned.queued_events(), 0);
}

#[test]
fn issue_5050_stream_refuses_surface_records_at_configured_retention_quotas() {
    let point_limited = landxml(
        r#"<Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces>"#,
    );
    let point_limits = LandXmlLimits {
        max_points: 2,
        ..LandXmlLimits::default()
    };
    assert_eq!(
        summary_after_byte_cuts_with_limits(point_limited.as_bytes(), point_limits.clone())
            .expect_err("third retained point exceeds the surface/document quota")
            .code,
        parse_landxml_tin_with_cancel(point_limited.as_bytes(), &point_limits, None)
            .expect_err("direct point quota")
            .code,
    );

    let face_limited = landxml(
        r#"<Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P><P id="4">1 1 0</P></Pnts><Faces><F>1 2 3</F><F>2 4 3</F></Faces></Definition></Surface></Surfaces>"#,
    );
    let face_limits = LandXmlLimits {
        max_faces: 1,
        ..LandXmlLimits::default()
    };
    assert_eq!(
        summary_after_byte_cuts_with_limits(face_limited.as_bytes(), face_limits.clone())
            .expect_err("second face exceeds the retained reference quota")
            .code,
        parse_landxml_tin_with_cancel(face_limited.as_bytes(), &face_limits, None)
            .expect_err("direct face quota")
            .code,
    );
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
    let mut ignored = Vec::new();
    for byte in xml {
        advance_and_drain(&mut session, std::slice::from_ref(byte), &mut ignored);
    }
    drain_until_idle(&mut session, &mut ignored);
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
fn issue_5161_pipe_preflight_refusal_precedes_its_network_without_reordering_semantics() {
    let xml = landxml(
        r#"<Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces><PipeNetworks><PipeNetwork name="storm" pipeNetType="storm"><Structs><Struct name="A"><Center>0 0 0</Center><CircStruct diameter="1"/><Invert refPipe="bad" flowDir="out" elev="bad"/></Struct><Struct name="B"><Center>10 0 0</Center><CircStruct diameter="1"/></Struct><Struct name="C"><Center>0 10 0</Center><CircStruct diameter="1"/></Struct><Struct name="D"><Center>10 10 0</Center><CircStruct diameter="1"/></Struct></Structs><Pipes><Pipe name="bad" refStart="A" refEnd="B"><CircPipe diameter="1"/></Pipe><Pipe name="good" refStart="C" refEnd="D"><CircPipe diameter="1"/></Pipe></Pipes></PipeNetwork></PipeNetworks>"#,
    );
    let direct = parse_landxml_document(xml.as_bytes()).expect("direct source document");
    let summary = summary_after_byte_cuts(xml.as_bytes()).expect("stream source document");
    assert_eq!(
        summary.metadata.terrain.pipe_networks, direct.terrain.pipe_networks,
        "cursor-only probes must not change the durable source document"
    );
    let mut session = LandXmlTinStreamSession::new(LandXmlLimits::default()).expect("session");
    let mut ignored_surface_events = Vec::new();
    advance_and_drain(&mut session, xml.as_bytes(), &mut ignored_surface_events);
    session.finish_cursor().expect("metadata cursor");
    let mut events = Vec::new();
    drain_until_idle(&mut session, &mut events);
    let mut preflight_refusal = None;
    let mut network = None;
    let mut semantic_refusal = None;
    for (index, event) in events.iter().enumerate() {
        let LandXmlStreamEvent::Metadata(metadata) = event else {
            continue;
        };
        let LandXmlMetadataStreamEvent::Record(record) = metadata.as_ref() else {
            continue;
        };
        match record.as_ref() {
            LandXmlMetadataRecord::PipePreflightRefusal(_) => preflight_refusal = Some(index),
            LandXmlMetadataRecord::PipeNetwork(_) => network = Some(index),
            LandXmlMetadataRecord::PipeRefusal(_) => semantic_refusal = Some(index),
            _ => {}
        }
    }
    assert!(preflight_refusal < network && network < semantic_refusal);
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
fn issue_5050_stream_finalizes_non_surface_metadata_without_a_second_source_scan() {
    let xml = landxml(&format!(
        r#"<Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces><CgPoints><CgPoint name="control">0 0 0</CgPoint></CgPoints><Alignments><Alignment name="a" length="1" staStart="0"><CoordGeom><Curve rot="cw" radius="1"><Start>0 0</Start><Center>0 1</Center><End>1 1</End></Curve></CoordGeom></Alignment></Alignments>{PIPE_NETWORK}"#
    ));
    let direct = parse_landxml_document(xml.as_bytes()).expect("direct source document");
    let direct_alignments =
        parse_landxml_alignments_optional(xml.as_bytes()).expect("direct alignment document");
    let summary = summary_after_byte_cuts(xml.as_bytes()).expect("stream source document");
    let mut expected_terrain = direct.terrain;
    let source_id = expected_terrain.surfaces[0].source_id.0.clone();
    expected_terrain.surfaces.clear();
    assert_eq!(summary.metadata.terrain, expected_terrain);
    assert_eq!(summary.metadata.plan, direct.plan);
    assert_eq!(summary.metadata.alignments, direct_alignments);
    assert_eq!(
        summary.metadata.alignment_render,
        ifc_lite_landxml::alignment::alignment_render_data(&summary.metadata.alignments)
    );
    let events = drive(xml.as_bytes(), std::iter::empty());
    assert!(events.iter().any(
        |event| matches!(event, LandXmlStreamEvent::Surface(fragment) if fragment.source_id == source_id)
    ));
}

#[test]
fn issue_5050_metadata_cursor_matches_direct_plan_and_uses_exact_credit_limits() {
    let points = (1..=8)
        .map(|ordinal| format!("<CgPoint name=\"p{ordinal}\">{ordinal} 0 0</CgPoint>"))
        .collect::<String>();
    let xml = landxml(&format!("<CgPoints>{points}</CgPoints>"));
    let direct = parse_landxml_plan(xml.as_bytes()).expect("direct plan");
    let mut session = LandXmlTinStreamSession::new(LandXmlLimits::default()).expect("session");
    session.advance(xml.as_bytes()).expect("source input");
    let mut ignored = Vec::new();
    drain_until_idle(&mut session, &mut ignored);

    session.finish_cursor().expect("begin metadata cursor");
    let mut metadata = Vec::new();
    let mut peak_events = 0;
    let mut peak_bytes = 0;
    while session.output_pending() {
        peak_events = peak_events.max(session.queued_events());
        peak_bytes = peak_bytes.max(session.queued_bytes());
        assert!(session.queued_events() <= MAX_LANDXML_STREAM_QUEUED_EVENTS);
        assert!(session.queued_bytes() <= MAX_LANDXML_STREAM_QUEUED_BYTES);
        for event in session
            .drain(MAX_LANDXML_STREAM_DRAIN_BYTES)
            .expect("credited metadata drain")
        {
            let LandXmlStreamEvent::Metadata(event) = event else {
                panic!("metadata cursor must not re-emit surface transport");
            };
            assert!(
                serde_json::to_vec(&event)
                    .expect("serialize bounded metadata")
                    .len()
                    <= MAX_LANDXML_STREAM_EVENT_BYTES
            );
            metadata.push(*event);
        }
    }
    assert_eq!(peak_events, MAX_LANDXML_STREAM_QUEUED_EVENTS);
    assert!(peak_bytes > 0);
    assert!(matches!(
        metadata.first(),
        Some(LandXmlMetadataStreamEvent::Header(_))
    ));
    assert!(matches!(
        metadata.last(),
        Some(LandXmlMetadataStreamEvent::End(_))
    ));
    assert_eq!(
        metadata
            .iter()
            .filter(|event| matches!(
                event,
                LandXmlMetadataStreamEvent::Record(record)
                    if matches!(record.as_ref(), LandXmlMetadataRecord::PlanCogoPoint(_))
            ))
            .count(),
        direct.cogo_points().len(),
    );

    let summary = summary_after_byte_cuts(xml.as_bytes()).expect("summary adapter cursor parity");
    assert_eq!(summary.metadata.plan, direct);
}

#[test]
fn issue_5161_streamed_resolved_geometry_includes_mixed_feature_and_parcel_loops() {
    let xml = landxml(
        r#"<PlanFeatures><PlanFeature name="road"><CoordGeom><Line><Start>1 2</Start><End>3 4</End></Line></CoordGeom></PlanFeature></PlanFeatures><Parcels><Parcel name="lot"><CoordGeom><Line><Start>10 20</Start><End>30 40</End></Line></CoordGeom></Parcel></Parcels>"#,
    );
    let direct = parse_landxml_plan(xml.as_bytes()).expect("direct plan");
    let expected = direct
        .plan_features
        .iter()
        .flat_map(|feature| feature.geometry.iter())
        .chain(
            direct
                .parcels
                .iter()
                .flat_map(|parcel| parcel.loops.iter().flatten()),
        )
        .map(|geometry| {
            (
                geometry.source_id.clone(),
                direct.resolve_point(geometry.point_scope_id.as_ref(), &geometry.start),
                direct.resolve_point(geometry.point_scope_id.as_ref(), &geometry.end),
                geometry.center.as_ref().and_then(|point| {
                    direct.resolve_point(geometry.point_scope_id.as_ref(), point)
                }),
                geometry.pi.as_ref().and_then(|point| {
                    direct.resolve_point(geometry.point_scope_id.as_ref(), point)
                }),
            )
        })
        .collect::<Vec<_>>();

    let mut session = LandXmlTinStreamSession::new(LandXmlLimits::default()).expect("session");
    let mut ignored = Vec::new();
    advance_and_drain(&mut session, xml.as_bytes(), &mut ignored);
    session.finish_cursor().expect("metadata cursor");
    let mut events = Vec::new();
    drain_until_idle(&mut session, &mut events);
    let streamed = events
        .into_iter()
        .filter_map(|event| match event {
            LandXmlStreamEvent::Metadata(metadata) => match *metadata {
                LandXmlMetadataStreamEvent::Record(record) => match *record {
                    LandXmlMetadataRecord::PlanResolvedGeometry(geometry) => Some((
                        geometry.source_id,
                        geometry.start,
                        geometry.end,
                        geometry.center,
                        geometry.pi,
                    )),
                    _ => None,
                },
                _ => None,
            },
            _ => None,
        })
        .collect::<Vec<_>>();

    assert_eq!(streamed, expected);
    assert_eq!(
        streamed.len(),
        2,
        "feature and parcel geometry are both emitted"
    );
}

#[test]
fn issue_5050_fragments_legal_large_nested_metadata_records_under_credit() {
    let value = "x".repeat(256 * 1024);
    let xml = landxml(&format!(
        r#"<PipeNetworks><PipeNetwork name="storm" pipeNetType="storm"><Feature label="vendor"><Property label="blob" value="{value}"/></Feature></PipeNetwork></PipeNetworks>"#
    ));
    let mut session = LandXmlTinStreamSession::new(LandXmlLimits {
        max_attribute_bytes: 512 * 1024,
        ..LandXmlLimits::default()
    })
    .expect("session");
    session.advance(xml.as_bytes()).expect("source input");
    let mut ignored = Vec::new();
    drain_until_idle(&mut session, &mut ignored);
    session.finish_cursor().expect("metadata cursor");
    let mut fragments = 0;
    while session.output_pending() {
        assert!(session.queued_bytes() <= MAX_LANDXML_STREAM_QUEUED_BYTES);
        for event in session
            .drain(MAX_LANDXML_STREAM_DRAIN_BYTES)
            .expect("credited metadata drain")
        {
            assert!(
                serde_json::to_vec(&event)
                    .expect("serialize bounded metadata event")
                    .len()
                    <= MAX_LANDXML_STREAM_EVENT_BYTES
            );
            if matches!(
                event,
                LandXmlStreamEvent::Metadata(metadata)
                    if matches!(metadata.as_ref(), LandXmlMetadataStreamEvent::RecordFragment(_))
            ) {
                fragments += 1;
            }
        }
    }
    assert!(fragments > 1, "large nested metadata must be fragmented");
}

#[test]
fn issue_5050_metadata_cursor_abort_and_drop_release_pending_owned_records() {
    let xml = landxml("<CgPoints><CgPoint name=\"control\">0 0 0</CgPoint></CgPoints>");
    let mut session = LandXmlTinStreamSession::new(LandXmlLimits::default()).expect("session");
    session.advance(xml.as_bytes()).expect("source input");
    let mut ignored = Vec::new();
    drain_until_idle(&mut session, &mut ignored);
    session.finish_cursor().expect("begin metadata cursor");
    assert!(session.output_pending());
    session.abort();
    assert!(!session.output_pending());
    assert_eq!(session.queued_events(), 0);
    assert_eq!(session.queued_bytes(), 0);
    assert_eq!(
        session
            .advance(&[])
            .expect_err("aborted stream is closed")
            .code,
        LandXmlDiagnosticCode::InvalidSemantic
    );

    let mut dropped = LandXmlTinStreamSession::new(LandXmlLimits::default()).expect("session");
    dropped.advance(xml.as_bytes()).expect("source input");
    drain_until_idle(&mut dropped, &mut ignored);
    dropped.finish_cursor().expect("begin metadata cursor");
    assert!(dropped.output_pending());
    drop(dropped);
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

#[test]
fn issue_5050_owned_decoder_matches_direct_encoding_and_entity_refusals() {
    let utf8 = format!(r#"<?xml version="1.0" encoding="UTF-8"?>{XML}"#);
    let utf8_direct = parse_landxml_tin(utf8.as_bytes()).expect("direct UTF-8 document");
    let utf8_stream = summary_after_byte_cuts(utf8.as_bytes()).expect("stream UTF-8 document");
    assert_eq!(utf8_stream.surfaces_drained, utf8_direct.surfaces.len());

    let utf16_document = format!(r#"<?xml version="1.0" encoding="UTF-16"?>{XML}"#);
    let utf16_be = utf16_document
        .encode_utf16()
        .flat_map(u16::to_be_bytes)
        .collect::<Vec<_>>();
    let utf16_direct = parse_landxml_tin(&utf16_be).expect("direct UTF-16BE document");
    let utf16_stream = summary_after_byte_cuts(&utf16_be).expect("stream UTF-16BE document");
    assert_eq!(utf16_stream.surfaces_drained, utf16_direct.surfaces.len());

    let declared_mismatch = format!(r#"<?xml version="1.0" encoding="ISO-8859-1"?>{XML}"#);
    assert_eq!(
        summary_after_byte_cuts(declared_mismatch.as_bytes())
            .expect_err("stream declared encoding mismatch")
            .code,
        parse_landxml_tin(declared_mismatch.as_bytes())
            .expect_err("direct declared encoding mismatch")
            .code
    );

    let forbidden_entity = XML.replace("0 0 0", "&forbidden;");
    assert_eq!(
        summary_after_byte_cuts(forbidden_entity.as_bytes())
            .expect_err("stream forbidden entity")
            .code,
        parse_landxml_tin(forbidden_entity.as_bytes())
            .expect_err("direct forbidden entity")
            .code
    );
}

#[test]
fn issue_5050_stream_applies_the_direct_markup_quota_before_quick_xml() {
    let limits = LandXmlLimits {
        max_name_bytes: 4,
        max_attributes: 1,
        max_attribute_bytes: 4,
        max_text_bytes: 64,
        ..LandXmlLimits::default()
    };
    let markup = format!("<LandXML {}>", "x".repeat(64));
    assert_eq!(
        summary_after_byte_cuts_with_limits(markup.as_bytes(), limits.clone())
            .expect_err("stream markup quota")
            .code,
        parse_landxml_tin_with_cancel(markup.as_bytes(), &limits, None)
            .expect_err("direct markup quota")
            .code
    );
}
