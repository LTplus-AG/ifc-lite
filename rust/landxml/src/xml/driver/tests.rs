/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::rc::Rc;

use super::*;
use crate::xml::{normalize_encoding, Meter};

const NS: &str = "http://www.landxml.org/schema/LandXML-1.2";

/// Records what the driver hands a family, and captures the text of `<c>`.
#[derive(Default)]
struct Recorder {
    log: Vec<String>,
    capturing: Option<usize>,
    namespaces: Vec<Rc<crate::xml::Namespaces>>,
    refuse_nested: bool,
}

impl FamilyHandler for Recorder {
    fn check_nesting(&mut self, depth: usize) -> Result<()> {
        match self.capturing {
            Some(open) if self.refuse_nested && open <= depth => Err(error(Code::InvalidSemantic, "nested")),
            _ => Ok(()),
        }
    }

    fn start(&mut self, cx: &Cx<'_>, element: &Element<'_>) -> Result<()> {
        self.log.push(format!("start {}@{} target={}", element.local, element.depth, element.target));
        self.namespaces.push(Rc::clone(&cx.frames().last().unwrap().namespaces));
        if element.local == "c" {
            self.capturing = Some(element.depth);
        }
        Ok(())
    }

    fn end(&mut self, cx: &Cx<'_>) -> Result<()> {
        self.log.push(format!("end {}", cx.frames().last().unwrap().local));
        if self.capturing == Some(cx.frames().len()) {
            self.capturing = None;
        }
        Ok(())
    }

    fn text(&mut self, _cx: &Cx<'_>, text: &str) -> Result<()> {
        self.log.push(format!("text {text:?}"));
        Ok(())
    }

    fn capture_depth(&self) -> Option<usize> {
        self.capturing
    }
}

fn run(xml: &str, limits: &LandXmlLimits, recorder: &mut Recorder) -> Result<RootInfo> {
    let bytes = normalize_encoding(xml.as_bytes(), limits, None)?;
    drive(&bytes, limits, None, Meter::new(limits.max_work, None), &mut [recorder])
}

fn doc(body: &str) -> String {
    format!(r#"<LandXML xmlns="{NS}" version="1.2">{body}</LandXML>"#)
}

fn code(xml: &str, limits: &LandXmlLimits) -> Code {
    run(xml, limits, &mut Recorder::default()).err().expect("refused").code
}

#[test]
fn a_family_sees_starts_ends_and_only_the_text_it_is_capturing() {
    let mut recorder = Recorder::default();
    let root = run(&doc("<a>ignored</a><c>1&#46;5 <![CDATA[&x;]]>2</c>"), &LandXmlLimits::default(), &mut recorder)
        .unwrap();
    assert_eq!(root.version, "1.2");
    assert_eq!(
        recorder.log,
        [
            "start LandXML@1 target=true",
            "start a@2 target=true",
            "end a",
            "start c@2 target=true",
            "text \"1\"",
            "text \".\"",
            "text \"5 \"",
            "text \"&x;\"",
            "text \"2\"",
            "end c",
            "end LandXML",
        ]
    );
}

#[test]
fn prefix_bindings_are_shared_until_an_element_declares_its_own() {
    let mut recorder = Recorder::default();
    run(&doc(r#"<a><b/></a><x xmlns:p="urn:p"><y/></x>"#), &LandXmlLimits::default(), &mut recorder).unwrap();
    let scopes = recorder.namespaces;
    // LandXML, a, b share the root's scope; x opens a new one that y shares.
    assert!(Rc::ptr_eq(&scopes[0], &scopes[1]) && Rc::ptr_eq(&scopes[1], &scopes[2]));
    assert!(!Rc::ptr_eq(&scopes[0], &scopes[3]) && Rc::ptr_eq(&scopes[3], &scopes[4]));
    assert_eq!(scopes[3].get("p").map(String::as_str), Some("urn:p"));
}

#[test]
fn foreign_namespace_elements_are_marked_and_never_match_a_path() {
    let mut recorder = Recorder::default();
    run(&doc(r#"<x xmlns="urn:other"><c/></x>"#), &LandXmlLimits::default(), &mut recorder).unwrap();
    assert_eq!(recorder.log[1], "start x@2 target=false");
    assert!(!path_is(&[Frame { local: "LandXML".into(), target: false, namespaces: Rc::default() }], &["LandXML"]));
}

#[test]
fn the_document_element_is_validated_once() {
    let limits = LandXmlLimits::default();
    assert_eq!(code("<Other/>", &limits), Code::InvalidSemantic);
    assert_eq!(code(r#"<LandXML xmlns="urn:other" version="1.2"/>"#, &limits), Code::UnsupportedNamespace);
    let twice = format!("{0}{0}", doc(""));
    let refusal = run(&twice, &limits, &mut Recorder::default()).err().unwrap();
    assert_eq!((refusal.code, refusal.message.as_str()), (Code::InvalidXml, "LandXML document has multiple root elements"));
}

#[test]
fn units_are_declared_once_and_kept_raw() {
    let limits = LandXmlLimits::default();
    let root = run(&doc(r#"<Units><Metric linearUnit="meter"/></Units>"#), &limits, &mut Recorder::default()).unwrap();
    assert_eq!(root.units.unwrap(), [("linearUnit".to_owned(), "meter".to_owned())]);
    let twice = doc(r#"<Units><Metric linearUnit="meter"/><Imperial linearUnit="foot"/></Units>"#);
    let refusal = run(&twice, &limits, &mut Recorder::default()).err().unwrap();
    assert_eq!((refusal.code, refusal.message.as_str()), (Code::InvalidSemantic, "LandXML may declare units only once"));
    // Not under LandXML/Units: not a declaration.
    assert!(run(&doc("<Other><Metric/><Metric/></Other>"), &limits, &mut Recorder::default()).unwrap().units.is_none());
}

#[test]
fn caps_and_end_of_document_checks_belong_to_the_driver() {
    let limits = LandXmlLimits::default();
    assert_eq!(code(&doc("<a><b><c/></b></a>"), &LandXmlLimits { max_depth: 3, ..limits.clone() }), Code::LimitExceeded);
    assert_eq!(code(&doc("<a/>"), &LandXmlLimits { max_work: 3, ..limits.clone() }), Code::LimitExceeded);
    assert_eq!(code(&doc("<a x=\"&#46;\"/>"), &LandXmlLimits { max_character_references: 0, ..limits.clone() }), Code::LimitExceeded);
    for (xml, message) in [("", "LandXML document is empty"), ("<?xml version=\"1.0\"?>", "LandXML document is empty")] {
        assert_eq!(run(xml, &limits, &mut Recorder::default()).err().unwrap().message, message);
    }
    let unclosed = doc("<a>").replace("</LandXML>", "");
    assert_eq!(run(&unclosed, &limits, &mut Recorder::default()).err().unwrap().message, "unclosed XML element");
}

#[test]
fn text_outside_the_root_and_dtds_are_refused() {
    let limits = LandXmlLimits::default();
    // The scanner refuses these first; the driver's own rules are the second line.
    let mut driver = Driver::new(&limits, Meter::new(limits.max_work, None));
    let none: &mut [&mut dyn FamilyHandler] = &mut [];
    assert_eq!(driver.text(b"x", none).unwrap_err().code, Code::InvalidXml);
    assert_eq!(driver.cdata(b" ", none).unwrap_err().code, Code::InvalidXml);
    driver.text(b" \n", none).unwrap();
    assert_eq!(
        driver.event(Event::DocType(quick_xml::events::BytesText::new("x")), none).unwrap_err().code,
        Code::DtdForbidden
    );
}

#[test]
fn a_handler_may_refuse_markup_nested_in_what_it_captures() {
    let mut recorder = Recorder { refuse_nested: true, ..Recorder::default() };
    let refusal = run(&doc("<c>1<x/>2</c>"), &LandXmlLimits::default(), &mut recorder).err().unwrap();
    assert_eq!(refusal.message, "nested");
}

#[test]
fn work_is_one_per_event_plus_attributes_plus_text_bytes() {
    let xml = doc(r#"<a b="1" c="2">xyz</a>"#);
    let spent = |max_work: usize| {
        run(&xml, &LandXmlLimits { max_work, ..LandXmlLimits::default() }, &mut Recorder::default()).is_ok()
    };
    // 5 events (LandXML, a, text, /a, /LandXML) + 2 + 2 attributes + 3 bytes.
    let expected = 5 + 2 + 2 + 3;
    assert!(spent(expected) && !spent(expected - 1));
}
