/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Entity and character-reference handling for text runs and attribute values.

use quick_xml::events::BytesRef;

use super::{error, Result};
use crate::LandXmlDiagnosticCode as Code;

pub(crate) fn character_references(value: &str) -> usize {
    value.bytes().filter(|byte| *byte == b'&').count()
}

/// Source text of a reference in element content (#7680 EDGE-LXPARSE-2).
///
/// quick-xml 0.42 ends a text event at `&` and reports each `&name;` as its
/// own `Event::GeneralRef`, so a family parser's text path never sees one.
/// Every `consume_event` hands this back to that text path instead, which
/// then applies the same rules as for any other text: one charge against
/// `max_character_references`, the outside-the-root refusal (so `&#32;`
/// cannot pass for padding), [`unescape`] (an undeclared entity is
/// `EntityForbidden`, exactly as in an attribute value), and the capture.
pub(crate) fn general_ref_source(reference: &BytesRef<'_>) -> String {
    format!("&{};", &**reference)
}

/// Resolve the predefined entities and numeric character references of one
/// attribute value or text run.
///
/// A numeric reference must name an XML `Char` (XML 1.0 production [2]):
/// `&#0;`, `&#xB;` and `&#xFFFE;` are malformed XML wherever they appear, so
/// they are `InvalidXml` rather than a character no consumer expects (D76).
/// A reference this does not recognise (`&#xZZ;`, `&other;`) is left for
/// quick-xml and reported as `EntityForbidden`.
pub(crate) fn unescape(value: &str) -> Result<std::borrow::Cow<'_, str>> {
    match quick_xml::escape::unescape(value) {
        // No reference in it, which is nearly every text run and attribute
        // value: nothing to check, and no second scan.
        Ok(std::borrow::Cow::Borrowed(text)) => Ok(std::borrow::Cow::Borrowed(text)),
        Ok(text) => check_character_references_are_xml_chars(value).map(|()| text),
        // quick-xml may refuse `&#0;` itself; name that for what it is.
        Err(_) => {
            check_character_references_are_xml_chars(value)?;
            Err(error(Code::EntityForbidden, "unknown XML entity reference"))
        }
    }
}

fn check_character_references_are_xml_chars(value: &str) -> Result<()> {
    // Hot path: nearly every run of text and attribute value has no `&`, and
    // `find(char)` is a memchr.
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
            return Err(error(
                Code::InvalidXml,
                "character reference does not name an XML character",
            ));
        }
    }
    Ok(())
}

/// XML 1.0 production [2] `Char`.
fn is_xml_char(code: u32) -> bool {
    matches!(code, 0x9 | 0xA | 0xD | 0x20..=0xD7FF | 0xE000..=0xFFFD | 0x1_0000..=0x10_FFFF)
}
