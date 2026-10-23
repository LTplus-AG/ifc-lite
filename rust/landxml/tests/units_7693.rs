// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7693 (B9): LandXML units, declaration sniffing and face semantics. Each
//! test states its invariant: a unit conversion round trip, one effective
//! unit across families, or a refusal no input shape can bypass.

use ifc_lite_landxml::alignment::{
    parse_landxml_alignments_optional_with_cancel, LandXmlAlignmentLimits,
};
use ifc_lite_landxml::{
    parse_landxml_pipe_networks_with_cancel, parse_landxml_plan_with_cancel,
    parse_landxml_tin_with_cancel, LandXmlDiagnosticCode, LandXmlLimits, LandXmlPlanLimits,
    LandXmlStreamSummary, LandXmlTinStreamSession, LANDXML_12_NAMESPACE,
    MAX_LANDXML_STREAM_DRAIN_BYTES,
};

fn plan_document(body: &str) -> String {
    format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter" areaUnit="squareMeter"/></Units>{body}</LandXML>"#
    )
}

const UNITLESS_FAMILIES: &str = r#"<CgPoints><CgPoint name="c">10 20 30</CgPoint></CgPoints><Parcels><Parcel name="square"><CoordGeom><Line><Start>0 0</Start><End>0 10</End></Line><Line><Start>0 10</Start><End>10 10</End></Line><Line><Start>10 10</Start><End>10 0</End></Line><Line><Start>10 0</Start><End>0 0</End></Line></CoordGeom></Parcel></Parcels><Alignments><Alignment name="a" length="10" staStart="0"><CoordGeom><Line><Start>0 0</Start><End>10 0</End></Line></CoordGeom></Alignment></Alignments><PipeNetworks><PipeNetwork name="storm" pipeNetType="storm"><Structs><Struct name="MH-1"><Center>0 0 10</Center><CircStruct diameter="4"/></Struct><Struct name="MH-2"><Center>0 10 8</Center><CircStruct diameter="4"/></Struct></Structs><Pipes><Pipe name="P-1" refStart="MH-1" refEnd="MH-2"><CircPipe diameter="2"/></Pipe></Pipes></PipeNetwork></PipeNetworks>"#;

fn unitless() -> String {
    format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2">{UNITLESS_FAMILIES}</LandXML>"#
    )
}

fn assumed(unit: &str) -> LandXmlLimits {
    LandXmlLimits {
        assumed_linear_unit: Some(unit.to_owned()),
        ..LandXmlLimits::default()
    }
}

/// EDGE-LXPARSE-7 (#7693). Invariant: one caller-supplied assumed linear
/// unit yields the same effective units in every family, and a source
/// value round-trips through that scale: `(x · s) / s = x`.
#[test]
fn edge_lxparse_7_assumed_unit_reaches_plan_alignment_and_pipe_families() {
    let xml = unitless();
    for (unit, scale) in [
        ("foot", 0.3048),
        ("USSurveyFoot", 1200.0 / 3937.0),
        ("meter", 1.0),
    ] {
        let limits = assumed(unit);
        let plan_limits = LandXmlPlanLimits {
            xml: limits.clone(),
            ..LandXmlPlanLimits::default()
        };
        let plan = parse_landxml_plan_with_cancel(xml.as_bytes(), &plan_limits, None)
            .expect("plan parses");
        let plan_units = plan.units.as_ref().expect("plan carries the assumed unit");
        assert!(plan_units.assumed, "{unit}");
        assert_eq!(plan_units.linear_scale_to_meters, scale, "{unit}");
        assert_eq!(
            plan.area_scale_to_square_meters,
            Some(scale * scale),
            "{unit}"
        );
        let square = plan.probe_parcel(&plan.parcels[0]);
        let metres = square.perimeter_in_meters.expect("perimeter in metres");
        assert!((metres / scale - 40.0).abs() < 1.0e-12, "{unit}: {metres}");

        let alignment_limits = LandXmlAlignmentLimits {
            xml: limits.clone(),
            ..LandXmlAlignmentLimits::default()
        };
        let alignment =
            parse_landxml_alignments_optional_with_cancel(xml.as_bytes(), &alignment_limits, None)
                .expect("alignment parses");
        assert_eq!(alignment.units.as_ref(), Some(plan_units), "{unit}");

        let pipes = parse_landxml_pipe_networks_with_cancel(xml.as_bytes(), &limits, None)
            .expect("pipes parse");
        assert!(pipes.refusals.is_empty(), "{unit}: {:?}", pipes.refusals);
        let pipe_units = pipes.root_units.as_ref().expect("pipe root units");
        // Read through serde so this test compiles against the base model.
        let flag = serde_json::to_value(pipe_units).expect("units serialize")["assumed"].clone();
        assert_eq!(flag, serde_json::Value::Bool(true), "{unit}");
        assert_eq!(pipe_units.linear_scale_to_meters, scale, "{unit}");
        assert_eq!(pipe_units.elevation_scale_to_meters, scale, "{unit}");
        assert_eq!(pipe_units.diameter_scale_to_meters, scale, "{unit}");
        let center = &pipes.networks[0].structures[1].center;
        assert_eq!(center.easting_meters / scale, 10.0, "{unit}");

        // The streaming session drives the same families from one limits value.
        let summary = stream_summary(xml.as_bytes(), limits).expect("stream");
        assert_eq!((summary.pipes, summary.pipe_refusals), (1, 0), "{unit}");
    }
}

fn stream_summary(
    bytes: &[u8],
    limits: LandXmlLimits,
) -> Result<LandXmlStreamSummary, ifc_lite_landxml::LandXmlError> {
    let mut session = LandXmlTinStreamSession::new(limits)?;
    let drain = |session: &mut LandXmlTinStreamSession| {
        while session.output_pending() {
            session.drain(MAX_LANDXML_STREAM_DRAIN_BYTES)?;
        }
        Ok::<(), ifc_lite_landxml::LandXmlError>(())
    };
    for chunk in bytes.chunks(512) {
        drain(&mut session)?;
        session.advance(chunk)?;
        drain(&mut session)?;
    }
    drain(&mut session)?;
    session.finish()
}

/// EDGE-LXPARSE-7 (#7693): an unknown assumed token is refused by every
/// entry point, before any record is read, not only by the TIN parser.
#[test]
fn edge_lxparse_7_unknown_assumed_token_is_refused_by_every_family() {
    let xml = unitless();
    let limits = assumed("furlong");
    let plan_limits = LandXmlPlanLimits {
        xml: limits.clone(),
        ..LandXmlPlanLimits::default()
    };
    let alignment_limits = LandXmlAlignmentLimits {
        xml: limits.clone(),
        ..LandXmlAlignmentLimits::default()
    };
    let errors = [
        parse_landxml_plan_with_cancel(xml.as_bytes(), &plan_limits, None).err(),
        parse_landxml_alignments_optional_with_cancel(xml.as_bytes(), &alignment_limits, None)
            .err(),
        parse_landxml_pipe_networks_with_cancel(xml.as_bytes(), &limits, None).err(),
    ];
    for error in errors {
        let error = error.expect("an unknown assumed unit must be refused");
        assert_eq!(error.code, LandXmlDiagnosticCode::InvalidSemantic);
        assert_eq!(error.message, "unsupported LandXML unit");
    }
}

/// EDGE-LXPARSE-7 (#7693): a declared `<Units>` still wins in every family;
/// the assumption is never marked as applied.
#[test]
fn edge_lxparse_7_declared_units_win_over_the_assumption_in_every_family() {
    let xml = plan_document(UNITLESS_FAMILIES);
    let limits = assumed("foot");
    let plan_limits = LandXmlPlanLimits {
        xml: limits.clone(),
        ..LandXmlPlanLimits::default()
    };
    let plan = parse_landxml_plan_with_cancel(xml.as_bytes(), &plan_limits, None).unwrap();
    assert!(!plan.units.expect("declared").assumed);
    let alignment_limits = LandXmlAlignmentLimits {
        xml: limits.clone(),
        ..LandXmlAlignmentLimits::default()
    };
    let alignment =
        parse_landxml_alignments_optional_with_cancel(xml.as_bytes(), &alignment_limits, None)
            .unwrap();
    assert_eq!(
        alignment.units.expect("declared").linear_scale_to_meters,
        1.0
    );
    let pipes = parse_landxml_pipe_networks_with_cancel(xml.as_bytes(), &limits, None).unwrap();
    let root = pipes.root_units.expect("declared");
    let flag = serde_json::to_value(&root).expect("units serialize")["assumed"].clone();
    assert_eq!(flag, serde_json::Value::Bool(false));
    assert_eq!(root.linear_scale_to_meters, 1.0);
}

/// EDGE-LXMATH-11 (#7693), pinning #5229's policy: an assumed unit applies
/// to elevations too, while a declared `<Units>` that omits
/// `elevationUnit` keeps LandXML 1.2's metre default.
#[test]
fn edge_lxmath_11_assumed_unit_scales_elevation_unlike_a_declared_default() {
    let tin = |units: &str| {
        format!(
            r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2">{units}<Surfaces><Surface name="t"><Definition surfType="TIN"><Pnts><P id="1">0 0 1</P><P id="2">0 1 1</P><P id="3">1 0 1</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces></LandXML>"#
        )
    };
    let assumed_units = parse_landxml_tin_with_cancel(tin("").as_bytes(), &assumed("foot"), None)
        .unwrap()
        .units
        .unwrap();
    assert_eq!(assumed_units.elevation_scale_to_meters, 0.3048);
    let declared = r#"<Units><Imperial linearUnit="foot"/></Units>"#;
    let declared_units =
        parse_landxml_tin_with_cancel(tin(declared).as_bytes(), &LandXmlLimits::default(), None)
            .unwrap()
            .units
            .unwrap();
    assert_eq!(declared_units.elevation_scale_to_meters, 1.0);
}

/// A document declaring ISO-8859-1 whose 1024-byte declaration window ends
/// inside a two-byte UTF-8 character.
fn latin1_declared_with_split_character() -> Vec<u8> {
    let declaration = r#"<?xml version="1.0" encoding="ISO-8859-1"?>"#;
    let open = "<!--";
    let padding = "x".repeat(1023 - declaration.len() - open.len());
    let mut bytes = format!("{declaration}{open}{padding}é-->").into_bytes();
    assert_eq!(&bytes[1023..1025], "é".as_bytes(), "é straddles byte 1024");
    bytes.extend_from_slice(plan_document("").as_bytes());
    bytes
}

/// EDGE-LXPARSE-23 (#7693): the unsupported-encoding refusal cannot be
/// skipped by padding the declaration window so it ends mid-character.
#[test]
fn edge_lxparse_23_split_character_cannot_hide_the_declared_encoding() {
    let bytes = latin1_declared_with_split_character();
    let error = parse_landxml_tin_with_cancel(&bytes, &LandXmlLimits::default(), None)
        .expect_err("ISO-8859-1 is not a supported declared encoding");
    assert_eq!(error.code, LandXmlDiagnosticCode::InvalidXml);

    let streamed = stream_summary(&bytes, LandXmlLimits::default())
        .expect_err("the streaming session refuses the same bytes");
    assert_eq!(streamed.code, LandXmlDiagnosticCode::InvalidXml);
}

/// EDGE-LXPARSE-27 (#7693): a face that repeats a vertex has no area. It is
/// kept as authored (source-preserving), and the document says so.
#[test]
fn edge_lxparse_27_repeated_vertex_face_is_kept_and_flagged() {
    let xml = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="t"><Definition surfType="TIN"><Pnts><P id="1">0 0 1</P><P id="2">0 1 1</P><P id="3">1 0 1</P></Pnts><Faces><F>1 2 3</F><F>1 1 2</F></Faces></Definition></Surface></Surfaces></LandXML>"#
    );
    let document =
        parse_landxml_tin_with_cancel(xml.as_bytes(), &LandXmlLimits::default(), None).unwrap();
    assert_eq!(
        document.surfaces[0].faces.len(),
        2,
        "faces stay as authored"
    );
    assert!(
        document
            .warnings
            .iter()
            .any(|warning| warning.contains("\"t\"") && warning.contains("1 face")),
        "{:?}",
        document.warnings
    );
}

const TIN_SURFACE: &str = r#"<Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces>"#;

/// Drive a stream over 64-byte chunks; returns the header events and the
/// first error, if any.
fn stream_headers(
    xml: &str,
    limits: LandXmlLimits,
) -> (Vec<ifc_lite_landxml::LandXmlStreamHeader>, Option<ifc_lite_landxml::LandXmlError>) {
    use ifc_lite_landxml::LandXmlStreamEvent;
    let mut session = LandXmlTinStreamSession::new(limits).expect("session");
    let mut headers = Vec::new();
    let mut pump = |session: &mut LandXmlTinStreamSession| -> Result<(), _> {
        while session.output_pending() {
            for event in session.drain(MAX_LANDXML_STREAM_DRAIN_BYTES)? {
                if let LandXmlStreamEvent::Header(h) = event {
                    headers.push(h);
                }
            }
        }
        Ok(())
    };
    for chunk in xml.as_bytes().chunks(64) {
        if let Err(e) = pump(&mut session).and_then(|()| session.advance(chunk)) {
            return (headers, Some(e));
        }
    }
    let result = pump(&mut session)
        .and_then(|()| session.finish_cursor())
        .and_then(|()| pump(&mut session));
    (headers, result.err())
}

/// #7753. Invariant: a declared `<Units>` always wins over an assumed linear
/// unit in the stream header, however late in the document it is read.
#[test]
fn issue_7753_stream_header_waits_for_a_declared_units_element() {
    let project = format!("<Project name=\"{}\"/>", "p".repeat(300));
    let xml = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2">{project}<Units><Metric linearUnit="meter"/></Units>{TIN_SURFACE}</LandXML>"#
    );
    let (headers, error) = stream_headers(&xml, assumed("foot"));
    assert!(error.is_none(), "{error:?}");
    assert_eq!(headers.len(), 1);
    let units = headers[0].units.as_ref().expect("units");
    assert!(!units.assumed, "declared metres, not the assumed foot");
    assert_eq!(units.linear_scale_to_meters, 1.0);
}

/// #7753. Invariant: a surface scaled by an assumed unit is never followed
/// by a contradicting declaration that goes unreported.
#[test]
fn issue_7753_units_after_a_scaled_surface_is_refused_not_ignored() {
    let xml = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2">{TIN_SURFACE}<Units><Metric linearUnit="meter"/></Units></LandXML>"#
    );
    let (_, error) = stream_headers(&xml, assumed("foot"));
    let error = error.expect("late Units after assumed scaling must be refused");
    assert!(error.to_string().contains("after"), "{error}");
}
