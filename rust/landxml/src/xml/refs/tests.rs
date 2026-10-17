/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::*;

fn budget(max: usize) -> Budget {
    Budget::new(max, "character reference")
}

const NAMES: &[&str] = &[
    "lt", "gt", "amp", "apos", "quot", "#46", "#x2E", "#x2e", "#0000046", "#128512", "#x1F600", "#9", "#xA", "#xD",
    "#0", "#xB", "#xFFFE", "#xD800", "#x110000", "#xZZ", "#", "#x", "#+5", "#-5", "#X2E", "other", "", "AMP",
    "#99999999999999999999",
];

#[test]
fn text_and_event_decoders_agree_on_every_reference() {
    for name in NAMES {
        let run = format!("&{name};");
        let from_text = decode_text(&run, &mut budget(10));
        let from_event = decode_ref(&BytesRef::new(*name), &mut budget(10));
        match (from_text, from_event) {
            (Ok(text), Ok(character)) => assert_eq!(text, character.to_string(), "&{name};"),
            (Err(text), Err(event)) => {
                assert_eq!((text.code, &text.message), (event.code, &event.message), "&{name};")
            }
            (text, event) => panic!("&{name}; differs: {text:?} vs {event:?}"),
        }
    }
}

#[test]
fn the_predefined_entities_and_numeric_references_resolve() {
    let mut chars = budget(100);
    assert_eq!(decode_text("a&lt;b&gt;&amp;&apos;&quot;&#46;&#x2E;&#x1F600;z", &mut chars).unwrap(), "a<b>&'\"..\u{1F600}z");
    assert!(matches!(decode_text("plain", &mut chars).unwrap(), Cow::Borrowed("plain")));
}

#[test]
fn each_reference_is_charged_once() {
    let mut chars = budget(3);
    decode_text("&#46;&#46;", &mut chars).unwrap();
    decode_ref(&BytesRef::new("amp"), &mut chars).unwrap();
    assert_eq!(decode_ref(&BytesRef::new("amp"), &mut chars).unwrap_err().message, "character reference limit exceeded");
    assert_eq!(decode_text("&amp;", &mut chars).unwrap_err().code, Code::LimitExceeded);
    // Text without a reference costs nothing, wherever the budget stands.
    decode_text("no references", &mut chars).unwrap();
}

#[test]
fn a_char_reference_to_a_non_char_is_invalid_xml_and_wins_over_an_unknown_entity() {
    for run in ["&#0;", "&#xB;", "&#xFFFE;", "&#xD800;", "&#x110000;", "&other;&#0;", "&#0;&other;"] {
        let refusal = decode_text(run, &mut budget(10)).unwrap_err();
        assert_eq!((refusal.code, refusal.message.as_str()), (Code::InvalidXml, "character reference does not name an XML character"), "{run}");
    }
}

#[test]
fn everything_else_is_a_forbidden_entity() {
    for run in ["&other;", "&#xZZ;", "&amp", "&;", "&&amp;", "a & b", "&#;", "&#x;"] {
        let refusal = decode_text(run, &mut budget(10)).unwrap_err();
        assert_eq!((refusal.code, refusal.message.as_str()), (Code::EntityForbidden, "unknown XML entity reference"), "{run}");
    }
}

#[test]
fn source_len_is_the_bytes_of_the_event() {
    assert_eq!(source_len(&BytesRef::new("amp")), "&amp;".len());
    assert_eq!(source_len(&BytesRef::new("#x1F600")), "&#x1F600;".len());
}

/// The pre-C9a-4 decoder (quick-xml's `unescape`, then a scan for numeric
/// references that are not XML `Char`s), kept here as the oracle the one
/// decoder must agree with on every run of references.
fn oracle(value: &str) -> Result<String> {
    fn check(value: &str) -> Result<()> {
        let mut rest = value;
        while let Some(start) = rest.find('&') {
            rest = &rest[start + 1..];
            let Some(digits) = rest.strip_prefix('#') else { continue };
            let Some(end) = digits.find(';') else { break };
            let digits = &digits[..end];
            let code = match digits.strip_prefix('x') {
                Some(hex) if hex.bytes().all(|byte| byte.is_ascii_hexdigit()) => u32::from_str_radix(hex, 16).ok(),
                Some(_) => None,
                None if digits.bytes().all(|byte| byte.is_ascii_digit()) => digits.parse::<u32>().ok(),
                None => None,
            };
            if code.is_some_and(|code| !is_xml_char(code)) {
                return Err(illegal());
            }
        }
        Ok(())
    }
    match quick_xml::escape::unescape(value) {
        Ok(text) => check(value).map(|()| text.into_owned()),
        Err(_) => {
            check(value)?;
            Err(error(Code::EntityForbidden, "unknown XML entity reference"))
        }
    }
}

#[test]
fn the_decoder_agrees_with_the_old_one_on_every_combination_of_fragments() {
    const FRAGMENTS: &[&str] = &[
        "&", ";", "amp", "lt", "#", "#46", "#x2E", "#0", "#xB", "#xZZ", "#x110000", "#xD800", "other", "x", " ", "&amp;",
        "&#46;", "&#0;", "&nope;",
    ];
    let mut checked = 0;
    let mut runs = vec![String::new()];
    for _ in 0..4 {
        let mut next = Vec::new();
        for run in &runs {
            for fragment in FRAGMENTS {
                next.push(format!("{run}{fragment}"));
            }
        }
        for run in &next {
            let new = decode_text(run, &mut budget(usize::MAX));
            let old = oracle(run);
            match (&new, &old) {
                (Ok(new), Ok(old)) => assert_eq!(new, old, "{run:?}"),
                (Err(new), Err(old)) => assert_eq!((new.code, &new.message), (old.code, &old.message), "{run:?}"),
                _ => panic!("{run:?}: {new:?} vs {old:?}"),
            }
            checked += 1;
        }
        runs = next;
    }
    assert!(checked > 100_000);
}
