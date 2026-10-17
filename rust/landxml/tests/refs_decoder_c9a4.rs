// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C9a-4 (#7784): one reference decoder for text runs, attribute values and
//! `GeneralRef` events. A reference is charged against
//! `max_character_references` and then resolved, wherever it appears, in
//! every family and in the stream, so an attribute that holds both an
//! over-budget run and an unknown entity reports the budget, as text does.

use ifc_lite_landxml::{
    alignment::{parse_landxml_alignments_optional_with_cancel, LandXmlAlignmentLimits},
    parse_landxml_pipe_networks_with_cancel, parse_landxml_plan_with_cancel,
    parse_landxml_tin_with_cancel, LandXmlDiagnosticCode as Code, LandXmlError, LandXmlLimits,
    LandXmlPlanLimits, LandXmlTinStreamSession,
};

const NS: &str = "http://www.landxml.org/schema/LandXML-1.2";

fn doc(body: &str) -> String {
    format!(r#"<LandXML xmlns="{NS}" version="1.2">{body}</LandXML>"#)
}

/// What every reader makes of `xml`.
fn refusals(xml: &str, limits: &LandXmlLimits) -> Vec<(&'static str, Option<(Code, String)>)> {
    let bytes = xml.as_bytes();
    let outcome = |name, error: Option<LandXmlError>| (name, error.map(|error| (error.code, error.message)));
    let stream = (|| {
        let mut session = LandXmlTinStreamSession::new(limits.clone())?;
        session.advance(bytes)?;
        session.finish().map(|_| ())
    })();
    vec![
        outcome("tin", parse_landxml_tin_with_cancel(bytes, limits, None).err()),
        outcome(
            "plan",
            parse_landxml_plan_with_cancel(bytes, &LandXmlPlanLimits { xml: limits.clone(), ..Default::default() }, None)
                .err(),
        ),
        outcome(
            "alignments",
            parse_landxml_alignments_optional_with_cancel(
                bytes,
                &LandXmlAlignmentLimits { xml: limits.clone(), ..Default::default() },
                None,
            )
            .err(),
        ),
        outcome("pipes", match parse_landxml_pipe_networks_with_cancel(bytes, limits, None) {
            Err(error) if error.message == "document contains no PipeNetwork records" => None,
            other => other.err(),
        }),
        outcome("stream", stream.err()),
    ]
}

fn expect_all(xml: &str, limits: &LandXmlLimits, code: Code, message: &str) {
    for (reader, refusal) in refusals(xml, limits) {
        assert_eq!(refusal, Some((code, message.to_owned())), "{reader}: {xml}");
    }
}

#[test]
fn an_attribute_charges_its_references_before_it_resolves_them() {
    let limits = LandXmlLimits { max_character_references: 1, ..LandXmlLimits::default() };
    expect_all(
        &doc(r#"<Other a="&#46;&#46;&nope;"/>"#),
        &limits,
        Code::LimitExceeded,
        "character reference limit exceeded",
    );
    // Within the budget the unknown entity is what is wrong.
    let roomy = LandXmlLimits::default();
    expect_all(&doc(r#"<Other a="&#46;&nope;"/>"#), &roomy, Code::EntityForbidden, "unknown XML entity reference");
}

#[test]
fn a_reference_in_element_text_is_charged_and_resolved_like_one_in_an_attribute() {
    let limits = LandXmlLimits { max_character_references: 2, ..LandXmlLimits::default() };
    expect_all(
        &doc("<Other>&#46;&amp;&lt;</Other>"),
        &limits,
        Code::LimitExceeded,
        "character reference limit exceeded",
    );
    let roomy = LandXmlLimits::default();
    expect_all(&doc("<Other>&nope;</Other>"), &roomy, Code::EntityForbidden, "unknown XML entity reference");
    for illegal in ["&#0;", "&#xB;", "&#xFFFE;"] {
        expect_all(
            &doc(&format!("<Other>{illegal}</Other>")),
            &roomy,
            Code::InvalidXml,
            "character reference does not name an XML character",
        );
        expect_all(
            &doc(&format!(r#"<Other a="{illegal}"/>"#)),
            &roomy,
            Code::InvalidXml,
            "character reference does not name an XML character",
        );
    }
}

#[test]
fn cdata_is_never_decoded() {
    // `&nope;` is data in CDATA, so no reader finds an unknown entity in it.
    let xml = doc("<Other><![CDATA[&nope;&#0;]]></Other>");
    for (reader, refusal) in refusals(&xml, &LandXmlLimits { max_character_references: 0, ..LandXmlLimits::default() }) {
        assert_eq!(refusal, None, "{reader}");
    }
}
