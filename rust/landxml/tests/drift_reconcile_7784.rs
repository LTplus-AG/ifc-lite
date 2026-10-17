// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C9a-1 (#7784, EDGE-LXPARSE-1/5/12/18/19): the four family parsers were
//! copies, and the copies had drifted. Each test here names one row of the
//! drift table in `docs`' C9a note and pins the single agreed behaviour on
//! every path that reads the bytes: the four pull entry points and the stream.
//! The pull-vs-stream scenarios live in `landxml_differential.rs`.

use ifc_lite_landxml::{
    alignment::{parse_landxml_alignments_optional_with_cancel, LandXmlAlignmentLimits},
    parse_landxml_pipe_networks_with_cancel, parse_landxml_plan_with_cancel,
    parse_landxml_tin_with_cancel, LandXmlDiagnosticCode as Code, LandXmlError, LandXmlLimits,
    LandXmlPlanLimits, LandXmlTinStreamSession, MAX_LANDXML_STREAM_DRAIN_BYTES,
};

const NS: &str = "http://www.landxml.org/schema/LandXML-1.2";

fn landxml(version: &str, body: &str) -> String {
    format!(r#"<LandXML xmlns="{NS}" version="{version}"><Units><Metric linearUnit="meter"/></Units>{body}</LandXML>"#)
}

fn valid(body: &str) -> String {
    landxml("1.2", body)
}

/// The refusal (code and message) from each of the five readers, in the order
/// TIN, plan, alignments, pipes, stream; `None` for a reader that accepted.
fn outcomes(xml: &str, limits: &LandXmlLimits) -> Vec<(&'static str, Option<LandXmlError>)> {
    let bytes = xml.as_bytes();
    let plan_limits = LandXmlPlanLimits { xml: limits.clone(), ..Default::default() };
    let alignment_limits = LandXmlAlignmentLimits { xml: limits.clone(), ..Default::default() };
    let pipes = parse_landxml_pipe_networks_with_cancel(bytes, limits, None).map(|_| ()).or_else(|error| {
        // The pull pipe API requires a PipeNetwork; absence is not a fault.
        if error.message == "document contains no PipeNetwork records" { Ok(()) } else { Err(error) }
    });
    vec![
        ("tin", parse_landxml_tin_with_cancel(bytes, limits, None).err()),
        ("plan", parse_landxml_plan_with_cancel(bytes, &plan_limits, None).err()),
        ("alignments", parse_landxml_alignments_optional_with_cancel(bytes, &alignment_limits, None).err()),
        ("pipes", pipes.err()),
        ("stream", stream(bytes, limits).err()),
    ]
}

fn stream(bytes: &[u8], limits: &LandXmlLimits) -> Result<(), LandXmlError> {
    let mut session = LandXmlTinStreamSession::new(limits.clone())?;
    for piece in bytes.chunks(5) {
        while session.output_pending() {
            session.drain(MAX_LANDXML_STREAM_DRAIN_BYTES)?;
        }
        session.advance(piece)?;
    }
    while session.output_pending() {
        session.drain(MAX_LANDXML_STREAM_DRAIN_BYTES)?;
    }
    session.finish().map(|_| ())
}

fn describe(outcomes: &[(&str, Option<LandXmlError>)]) -> String {
    outcomes
        .iter()
        .map(|(name, error)| format!("{name}: {}", error.as_ref().map_or("ok".to_owned(), |e| format!("{:?} {}", e.code, e.message))))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Every reader refused with this code and message.
fn assert_all_refuse(xml: &str, limits: &LandXmlLimits, code: Code, message: &str) {
    let outcomes = outcomes(xml, limits);
    for (name, error) in &outcomes {
        let ok = error.as_ref().is_some_and(|e| e.code == code && e.message == message);
        assert!(ok, "{name} must refuse with {code:?} {message:?}\n{}", describe(&outcomes));
    }
}

/// Every reader refused with this code (message may differ).
fn assert_all_refuse_code(xml: &str, limits: &LandXmlLimits, code: Code) {
    let outcomes = outcomes(xml, limits);
    for (name, error) in &outcomes {
        assert!(error.as_ref().is_some_and(|e| e.code == code), "{name} must refuse with {code:?}\n{}", describe(&outcomes));
    }
}

fn assert_all_accept(xml: &str, limits: &LandXmlLimits) {
    let outcomes = outcomes(xml, limits);
    assert!(outcomes.iter().all(|(_, error)| error.is_none()), "{}", describe(&outcomes));
}

/// Row 1: work is events + attributes + text bytes, charged once in
/// `consume_event`, so every family spends the same on a document none of
/// them has a record for. Character references are not work (D73).
#[test]
fn drift_1_every_family_spends_the_same_work() {
    let xml = valid(r#"<Other a="&#46;" b="2">1&#46;5 <Child/>tail</Other>"#);
    let spent: Vec<usize> = (0..4)
        .map(|family| {
            let (mut refused, mut accepted) = (0usize, 100_000usize);
            while accepted - refused > 1 {
                let middle = refused + (accepted - refused) / 2;
                let limits = LandXmlLimits { max_work: middle, ..LandXmlLimits::default() };
                if outcomes(&xml, &limits)[family].1.is_none() { accepted = middle } else { refused = middle }
            }
            accepted
        })
        .collect();
    assert!(spent.windows(2).all(|pair| pair[0] == pair[1]), "work per family (tin, plan, alignments, pipes): {spent:?}");
}

/// Row 2: the version-mismatch diagnostic is a bounded capability diagnostic
/// in every family, not an unbounded push in three of them.
#[test]
fn drift_2_version_mismatch_diagnostic_is_bounded_in_every_family() {
    let xml = landxml("1.1", "");
    assert_all_accept(&xml, &LandXmlLimits::default());
    let none = LandXmlLimits { max_capability_diagnostics: 0, ..LandXmlLimits::default() };
    assert_all_refuse(&xml, &none, Code::LimitExceeded, "capability diagnostic limit exceeded");
}

/// Row 4: one text per root-level refusal.
#[test]
fn drift_4_root_refusals_read_the_same_in_every_family() {
    let two = format!("{}{}", valid(""), valid(""));
    assert_all_refuse(&two, &LandXmlLimits::default(), Code::InvalidXml, "LandXML document has multiple root elements");
    assert_all_refuse(
        &landxml("9.9", ""),
        &LandXmlLimits::default(),
        Code::UnsupportedVersion,
        "LandXML namespaces require a known version declaration",
    );
    assert_all_refuse(
        &valid("").replace(NS, "urn:other"),
        &LandXmlLimits::default(),
        Code::UnsupportedNamespace,
        "root namespace is not a recognized LandXML namespace",
    );
}

/// Row 5: no root is empty; a root that never closes is unclosed.
#[test]
fn drift_5_empty_and_unclosed_documents_read_the_same_in_every_family() {
    let limits = LandXmlLimits::default();
    for empty in ["", "  \n", "<!-- nothing -->", "<?xml version=\"1.0\"?>"] {
        assert_all_refuse(empty, &limits, Code::InvalidXml, "LandXML document is empty");
    }
    let unclosed = valid("").replace("</LandXML>", "");
    assert_all_refuse(&unclosed, &limits, Code::InvalidXml, "unclosed XML element");
}

/// Row 7 (D74): markup inside a numeric capture is refused, not read as the
/// text around it. TIN used to read `1 2 <Foo>9</Foo>3` as `1 2 3`.
#[test]
fn drift_7_tin_refuses_an_element_inside_a_numeric_capture() {
    let point = r#"<Surfaces><Surface name="s"><Definition surfType="TIN"><Pnts><P id="1">1 2 <Foo>9</Foo>3</P></Pnts></Definition></Surface></Surfaces>"#;
    let face = r#"<Surfaces><Surface name="s"><Definition surfType="TIN"><Pnts><P id="1">1 2 3</P><P id="2">1 2 3</P><P id="3">1 2 3</P></Pnts><Faces><F>1 2 <Foo/>3</F></Faces></Definition></Surface></Surfaces>"#;
    for body in [point, face] {
        let xml = valid(body);
        let error = parse_landxml_tin_with_cancel(xml.as_bytes(), &LandXmlLimits::default(), None).expect_err("nested element");
        assert_eq!(error.code, Code::InvalidSemantic, "{error:?}");
        assert_eq!(error.message, "numeric LandXML capture cannot contain nested elements");
        let streamed = stream(xml.as_bytes(), &LandXmlLimits::default()).expect_err("stream");
        assert_eq!((streamed.code, streamed.message.as_str()), (error.code, error.message.as_str()));
    }
}

/// Row 7: the families that already refused still do.
#[test]
fn drift_7_plan_and_alignment_keep_refusing_nested_captures() {
    let plan = valid("<CgPoints><CgPoint name=\"c\">1 2 <Foo/>3</CgPoint></CgPoints>");
    let align = valid(r#"<Alignments><Alignment name="a" length="1" staStart="0"><CoordGeom><Line><Start>0 <Foo/>0</Start><End>1 0</End></Line></CoordGeom></Alignment></Alignments>"#);
    let limits = LandXmlLimits::default();
    for (xml, family) in [(&plan, 1usize), (&align, 2)] {
        let outcomes = outcomes(xml, &limits);
        let error = outcomes[family].1.as_ref().expect("nested capture refused");
        assert_eq!(error.code, Code::InvalidSemantic, "{}", describe(&outcomes));
        assert_eq!(error.message, "numeric LandXML capture cannot contain nested elements");
    }
}

/// Row 8: an exhausted alignment cap is a limit, not a semantic fault.
#[test]
fn drift_8_alignment_limit_is_limit_exceeded() {
    let xml = valid(r#"<Alignments><Alignment name="a" length="1" staStart="0"/></Alignments>"#);
    let limits = LandXmlAlignmentLimits {
        max_alignments: 0,
        ..LandXmlAlignmentLimits::default()
    };
    let error = parse_landxml_alignments_optional_with_cancel(xml.as_bytes(), &limits, None).expect_err("cap of zero");
    assert_eq!((error.code, error.message.as_str()), (Code::LimitExceeded, "alignment limit exceeded"));
}

/// Row 9: a pipe record's properties never carry namespace declarations, as
/// in the TIN and plan families.
#[test]
fn drift_9_pipe_properties_drop_namespace_declarations() {
    let xml = valid(
        r#"<PipeNetworks xmlns:q="urn:q"><PipeNetwork name="n" pipeNetType="storm" xmlns:r="urn:r"><Structs><Struct name="A" xmlns:s="urn:s"><Center>0 0 0</Center><CircStruct diameter="1"/></Struct><Struct name="B"><Center>0 1 0</Center><CircStruct diameter="1"/></Struct></Structs><Pipes><Pipe name="P" refStart="A" refEnd="B" xmlns:t="urn:t"><CircPipe diameter="1"/></Pipe></Pipes></PipeNetwork></PipeNetworks>"#,
    );
    let document = parse_landxml_pipe_networks_with_cancel(xml.as_bytes(), &LandXmlLimits::default(), None).expect("pipes");
    let json = serde_json::to_string(&document).expect("json");
    assert!(json.contains("\"pipeNetType\""), "the properties are still there: {json}");
    assert!(json.contains("\"networks\":[{"), "the network parsed: {json}");
    assert!(!json.contains("xmlns"), "namespace declarations leaked into properties: {json}");
}

/// Row 10: `<!-->x-->` is a comment with the content `>x`, not an unterminated
/// token and not a premature end.
#[test]
fn drift_10_comment_terminator_is_searched_after_the_opener() {
    for comment in ["<!-->x-->", "<!--->x-->", "<!---->", "<!-- a -->"] {
        let xml = valid("").replace("<Units>", &format!("{comment}<Units>"));
        assert_all_accept(&xml, &LandXmlLimits::default());
    }
    let unterminated = valid("").replace("<Units>", "<!-->x<Units>");
    assert_all_refuse_code(&unterminated, &LandXmlLimits::default(), Code::InvalidXml);
}

/// Row 11 (D76): a character reference to a non-XML Char is malformed XML in
/// text and in attribute values, on every path.
#[test]
fn drift_11_character_references_must_name_xml_chars() {
    for reference in ["&#0;", "&#1;", "&#8;", "&#xB;", "&#x1F;", "&#xFFFE;", "&#xFFFF;", "&#x0;"] {
        let text = valid(&format!("<Other>{reference}</Other>"));
        let attribute = valid(&format!(r#"<Other a="{reference}"/>"#));
        for xml in [text, attribute] {
            let outcomes = outcomes(&xml, &LandXmlLimits::default());
            for (name, error) in &outcomes {
                assert!(
                    error.as_ref().is_some_and(|e| e.code == Code::InvalidXml),
                    "{reference} in {xml}: {name} must refuse as InvalidXml\n{}",
                    describe(&outcomes)
                );
            }
        }
    }
    for reference in ["&#9;", "&#xA;", "&#13;", "&#32;", "&#xD7FF;", "&#xE000;", "&#xFFFD;", "&#x10000;", "&#x10FFFF;", "&amp;", "&lt;"] {
        assert_all_accept(&valid(&format!(r#"<Other a="{reference}">{reference}</Other>"#)), &LandXmlLimits::default());
    }
}

/// The viewer decides to offer a unit picker by two substrings of one message
/// (`apps/viewer/src/hooks/ingest/landXmlUnitsRefusal.ts`). Freeze the
/// message, and make sure no other refusal can trip the picker.
#[test]
fn units_refusal_message_is_frozen_and_unique() {
    const FROZEN: &str = "a numeric, renderable TIN surface requires a LandXML/Units element with a linearUnit attribute";
    let unitless = format!(
        r#"<LandXML xmlns="{NS}" version="1.2"><Surfaces><Surface name="s"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces></LandXML>"#
    );
    for (name, error) in outcomes(&unitless, &LandXmlLimits::default()) {
        if let Some(error) = error {
            assert_eq!(error.message, FROZEN, "{name}");
            assert_eq!(error.to_string(), format!("LXML009: {FROZEN}"), "{name}");
        } else {
            assert!(["plan", "alignments", "pipes"].contains(&name), "{name} must refuse a unitless TIN");
        }
    }
    // Every other refusal in this file, plus the late-Units stream refusal.
    let late = format!(
        r#"<LandXML xmlns="{NS}" version="1.2"><Surfaces><Surface name="s"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces><Units><Metric linearUnit="meter"/></Units></LandXML>"#
    );
    let assumed = LandXmlLimits { assumed_linear_unit: Some("foot".to_owned()), ..LandXmlLimits::default() };
    let late_error = stream(late.as_bytes(), &assumed).expect_err("late Units");
    let refusals = [
        late_error,
        stream(valid("<Other>&#0;</Other>").as_bytes(), &LandXmlLimits::default()).expect_err("char ref"),
        stream(valid("").replace("</LandXML>", "").as_bytes(), &LandXmlLimits::default()).expect_err("unclosed"),
        stream(landxml("9.9", "").as_bytes(), &LandXmlLimits::default()).expect_err("version"),
        stream(valid(r#"<Units><Imperial linearUnit="foot"/></Units>"#).as_bytes(), &LandXmlLimits::default()).expect_err("units twice"),
        stream(valid("<Alignments><Alignment/></Alignments>").as_bytes(), &LandXmlLimits::default()).expect_err("alignment"),
    ];
    for error in refusals {
        assert!(
            !(error.message.contains("linearUnit") && error.message.contains("LandXML/Units")),
            "{error:?} would offer the viewer's unit picker"
        );
    }
}
