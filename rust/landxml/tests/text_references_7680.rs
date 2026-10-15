/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! #7680 EDGE-LXPARSE-2: character and entity references in element text.
//!
//! quick-xml 0.42 ends a text event at `&` and reports each `&name;` as its
//! own `Event::GeneralRef`. Every family parser must resolve it exactly as
//! the literal character, refuse an undeclared entity the way the attribute
//! path does, refuse it outside the root and charge it to the character
//! reference cap. The invariant pinned here is family-independent: a source
//! that spells a character as a reference parses identically to the source
//! that spells it literally.

use ifc_lite_landxml::{
    alignment::{parse_landxml_alignments_optional_with_cancel, LandXmlAlignmentLimits},
    parse_landxml_pipe_networks_with_cancel, parse_landxml_plan_with_cancel,
    parse_landxml_tin_with_cancel, LandXmlDiagnosticCode, LandXmlError, LandXmlLimits,
    LandXmlPlanLimits,
};
use serde_json::Value;

/// One source carrying a text capture for each of the four family parsers.
/// `{p1}`, `{f}`, `{cg}`, `{end}` and `{center}` are the reference sites.
const TEMPLATE: &str = r#"<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts><P id="1">{p1}</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>{f}</F></Faces></Definition></Surface></Surfaces><CgPoints><CgPoint name="control">{cg}</CgPoint></CgPoints><Alignments><Alignment name="a" length="1" staStart="0"><CoordGeom><Line><Start>0 0</Start><End>{end}</End></Line></CoordGeom></Alignment></Alignments><PipeNetworks><PipeNetwork name="storm" pipeNetType="storm"><Structs><Struct name="A"><Center>0 0 0</Center><CircStruct diameter="1"/></Struct><Struct name="B"><Center>{center}</Center><CircStruct diameter="1"/></Struct></Structs><Pipes><Pipe name="P" refStart="A" refEnd="B"><CircPipe diameter="1"/></Pipe></Pipes></PipeNetwork></PipeNetworks></LandXML>"#;

/// The reference spelling of every site, and its literal twin.
const REFERENCES: [(&str, &str, &str); 5] = [
    ("{p1}", "0&#46;5 0 0", "0.5 0 0"),
    ("{f}", "1&#32;2&#x20;3", "1 2 3"),
    ("{cg}", "1&#x2E;25 2 3", "1.25 2 3"),
    ("{end}", "1&#46;0 0", "1.0 0"),
    ("{center}", "0 1&#46;0 0", "0 1.0 0"),
];

fn source(literal: bool) -> String {
    REFERENCES
        .iter()
        .fold(TEMPLATE.to_owned(), |xml, (site, reference, plain)| {
            xml.replace(site, if literal { plain } else { reference })
        })
}

type Family = fn(&[u8], &LandXmlLimits) -> Result<Value, LandXmlError>;

fn tin(input: &[u8], limits: &LandXmlLimits) -> Result<Value, LandXmlError> {
    parse_landxml_tin_with_cancel(input, limits, None).map(|doc| json(&doc))
}
fn plan(input: &[u8], limits: &LandXmlLimits) -> Result<Value, LandXmlError> {
    let limits = LandXmlPlanLimits {
        xml: limits.clone(),
        ..LandXmlPlanLimits::default()
    };
    parse_landxml_plan_with_cancel(input, &limits, None).map(|doc| json(&doc))
}
fn alignment(input: &[u8], limits: &LandXmlLimits) -> Result<Value, LandXmlError> {
    let limits = LandXmlAlignmentLimits {
        xml: limits.clone(),
        ..LandXmlAlignmentLimits::default()
    };
    parse_landxml_alignments_optional_with_cancel(input, &limits, None).map(|doc| json(&doc))
}
fn pipe(input: &[u8], limits: &LandXmlLimits) -> Result<Value, LandXmlError> {
    parse_landxml_pipe_networks_with_cancel(input, limits, None).map(|doc| json(&doc))
}
fn json(value: &impl serde::Serialize) -> Value {
    serde_json::to_value(value).expect("parsed documents serialize")
}

const FAMILIES: [(&str, Family); 4] = [
    ("tin", tin),
    ("plan", plan),
    ("alignment", alignment),
    ("pipe", pipe),
];

/// A parse outcome compared by value, or by refusal code.
fn outcome(result: Result<Value, LandXmlError>) -> Result<Value, LandXmlDiagnosticCode> {
    result.map_err(|error| error.code)
}

/// Collects every mismatch, so one run shows each family that is wrong.
#[derive(Default)]
struct Mismatches(Vec<String>);

impl Mismatches {
    fn check<T: PartialEq + std::fmt::Debug>(&mut self, context: &str, actual: T, expected: T) {
        if actual != expected {
            let actual = format!("{actual:?}");
            let expected = format!("{expected:?}");
            self.0.push(format!(
                "{context}: got {:.160} expected {:.160}",
                actual, expected
            ));
        }
    }
    fn assert_none(self) {
        assert!(self.0.is_empty(), "{:#?}", self.0);
    }
}

/// `TEMPLATE` with `site` spelled as `text` and every other site literal.
fn with_site(site: &str, text: &str) -> String {
    REFERENCES
        .iter()
        .fold(TEMPLATE.replace(site, text), |xml, (other, _, plain)| {
            xml.replace(other, plain)
        })
}

#[test]
fn issue_7680_edge_lxparse_2_text_references_parse_like_their_literal_characters() {
    let limits = LandXmlLimits::default();
    let referenced = source(false);
    let literal = source(true);
    let mut mismatches = Mismatches::default();
    for (name, family) in FAMILIES {
        mismatches.check(
            name,
            outcome(family(referenced.as_bytes(), &limits)),
            outcome(family(literal.as_bytes(), &limits)),
        );
    }
    mismatches.assert_none();
    // The reported #7680 case directly: `0&#46;5` was read as `05`.
    let terrain = parse_landxml_tin_with_cancel(referenced.as_bytes(), &limits, None).unwrap();
    assert_eq!(terrain.surfaces[0].points[0].northing, 0.5);
}

#[test]
fn issue_7680_edge_lxparse_2_predefined_entities_in_text_are_their_literal_characters() {
    // `&amp;` must reach the numeric capture as `&`, exactly like the same
    // byte inside CDATA, instead of vanishing and leaving a valid triple.
    let limits = LandXmlLimits::default();
    let mut mismatches = Mismatches::default();
    // `&amp;#46;` is the text `&#46;`, never a second expansion to `.`.
    let spellings = [("&amp;", "&"), ("&lt;", "<"), ("&amp;#46;", "&#46;")];
    for ((site, _, plain), (escaped, raw)) in REFERENCES
        .iter()
        .flat_map(|row| spellings.iter().map(move |pair| (row, pair)))
    {
        let entity = with_site(site, &format!("{plain}{escaped}"));
        let cdata = with_site(site, &format!("<![CDATA[{plain}{raw}]]>"));
        for (name, family) in FAMILIES {
            mismatches.check(
                &format!("{name} {site} {escaped}"),
                outcome(family(entity.as_bytes(), &limits)),
                outcome(family(cdata.as_bytes(), &limits)),
            );
        }
    }
    mismatches.assert_none();
}

#[test]
fn issue_7680_edge_lxparse_2_undeclared_text_entities_are_refused_like_attributes() {
    let limits = LandXmlLimits::default();
    let mut mismatches = Mismatches::default();
    for (site, _, plain) in REFERENCES {
        let xml = with_site(site, &format!("{plain}&custom;"));
        // A family that does not capture this site still reads the reference
        // as document text, and must refuse it all the same.
        for (name, family) in FAMILIES {
            mismatches.check(
                &format!("{name} {site}"),
                outcome(family(xml.as_bytes(), &limits)).err(),
                Some(LandXmlDiagnosticCode::EntityForbidden),
            );
        }
    }
    mismatches.assert_none();
}

#[test]
fn issue_7680_edge_lxparse_2_text_references_outside_the_root_are_refused() {
    let limits = LandXmlLimits::default();
    let valid = source(true);
    let mut mismatches = Mismatches::default();
    for xml in [
        format!("&#32;{valid}"),
        format!("{valid}&#32;"),
        format!("{valid}&amp;"),
    ] {
        for (name, family) in FAMILIES {
            mismatches.check(
                &format!("{name} {:?}", xml.get(..8).filter(|_| xml.starts_with('&'))),
                outcome(family(xml.as_bytes(), &limits)).err(),
                Some(LandXmlDiagnosticCode::InvalidXml),
            );
        }
    }
    mismatches.assert_none();
}

#[test]
fn issue_7680_edge_lxparse_2_text_references_charge_the_character_reference_cap() {
    let referenced = source(false);
    // Every family charges every reference in the document, captured or
    // not; the template has no reference in any attribute.
    let total = referenced.matches('&').count();
    assert_eq!(total, 6);
    let mut mismatches = Mismatches::default();
    for (name, family) in FAMILIES {
        let at_cap = LandXmlLimits {
            max_character_references: total,
            ..LandXmlLimits::default()
        };
        mismatches.check(
            &format!("{name} at cap"),
            outcome(family(referenced.as_bytes(), &at_cap)).is_ok(),
            true,
        );
        let below_cap = LandXmlLimits {
            max_character_references: total - 1,
            ..LandXmlLimits::default()
        };
        mismatches.check(
            &format!("{name} below cap"),
            outcome(family(referenced.as_bytes(), &below_cap)).err(),
            Some(LandXmlDiagnosticCode::LimitExceeded),
        );
    }
    mismatches.assert_none();
}
