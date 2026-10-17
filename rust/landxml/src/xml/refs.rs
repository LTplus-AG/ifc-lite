/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! The one entity and character-reference decoder (C9a-4, #7784).
//!
//! quick-xml 0.42 ends a text event at `&` and reports each `&name;` as its
//! own `Event::GeneralRef`. Four family parsers used to rebuild `"&name;"`
//! from it and send it back through the text path, which charged
//! `max_character_references`, called `unescape` and appended the result,
//! each in its own copy. Text runs, attribute values and `GeneralRef` events
//! now all resolve here, and every reference is charged once.
//!
//! The rules:
//! - the five predefined entities, and numeric references (`&#46;`,
//!   `&#x2E;`);
//! - a numeric reference must name an XML `Char` (XML 1.0 production [2]):
//!   `&#0;`, `&#xB;` and `&#xFFFE;` are `InvalidXml` wherever they appear
//!   (D76), and win over an unknown entity in the same run;
//! - anything else (`&other;`, `&#xZZ;`, an unterminated `&`) is
//!   `EntityForbidden`: no DTD, so no other entity can be declared;
//! - CDATA is never decoded; its callers pass it through literally.

use std::borrow::Cow;

use memchr::memchr_iter;
use quick_xml::events::BytesRef;

use super::{error, Budget, Result};
use crate::{LandXmlDiagnosticCode as Code, LandXmlError};

/// Source length of a reference event (`&` + name + `;`), the bytes charged
/// as work and measured against the text cap.
pub(crate) fn source_len(reference: &BytesRef<'_>) -> usize {
    reference.len() + 2
}

/// Resolve every reference in one text run or attribute value, charging
/// `char_refs` once per `&` first.
pub(crate) fn decode_text<'a>(raw: &'a str, char_refs: &mut Budget) -> Result<Cow<'a, str>> {
    let references = memchr_iter(b'&', raw.as_bytes()).count();
    if references == 0 {
        return Ok(Cow::Borrowed(raw));
    }
    char_refs.reserve(references)?;
    let mut decoded = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(at) = rest.find('&') {
        decoded.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        // A `&` before the `;` leaves the first reference unterminated.
        let Some(end) = after.find([';', '&']).filter(|end| after.as_bytes()[*end] == b';') else {
            return Err(forbidden(raw));
        };
        decoded.push(match resolve(&after[..end]) {
            Ok(character) => character,
            Err(Fault::Illegal) => return Err(illegal()),
            Err(Fault::Unknown) => return Err(forbidden(raw)),
        });
        rest = &after[end + 1..];
    }
    decoded.push_str(rest);
    Ok(Cow::Owned(decoded))
}

/// Resolve one `GeneralRef` event, charging `char_refs` once. Every
/// reference names one character.
pub(crate) fn decode_ref(reference: &BytesRef<'_>, char_refs: &mut Budget) -> Result<char> {
    char_refs.reserve(1)?;
    resolve(reference).map_err(|fault| match fault {
        Fault::Illegal => illegal(),
        Fault::Unknown => forbidden(&format!("&{};", &**reference)),
    })
}

enum Fault {
    /// A numeric reference to something that is not an XML `Char`.
    Illegal,
    /// Not a predefined entity, or not a well-formed numeric reference.
    Unknown,
}

fn resolve(name: &str) -> std::result::Result<char, Fault> {
    let Some(number) = name.strip_prefix('#') else {
        return match name {
            "lt" => Ok('<'),
            "gt" => Ok('>'),
            "amp" => Ok('&'),
            "apos" => Ok('\''),
            "quot" => Ok('"'),
            _ => Err(Fault::Unknown),
        };
    };
    let code = match number.strip_prefix('x') {
        Some(hex) if !hex.is_empty() && hex.bytes().all(|byte| byte.is_ascii_hexdigit()) => {
            u32::from_str_radix(hex, 16).ok()
        }
        None if !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()) => number.parse().ok(),
        _ => None,
    };
    let code = code.ok_or(Fault::Unknown)?;
    if is_xml_char(code) { char::from_u32(code).ok_or(Fault::Illegal) } else { Err(Fault::Illegal) }
}

fn illegal() -> LandXmlError {
    error(Code::InvalidXml, "character reference does not name an XML character")
}

/// An unknown entity, unless the run also holds an illegal numeric reference
/// (which is the more specific fault, wherever it sits).
fn forbidden(run: &str) -> LandXmlError {
    let mut rest = run;
    while let Some(at) = rest.find("&#") {
        rest = &rest[at + 2..];
        let Some(end) = rest.find(';') else { break };
        if matches!(resolve(&format!("#{}", &rest[..end])), Err(Fault::Illegal)) {
            return illegal();
        }
    }
    error(Code::EntityForbidden, "unknown XML entity reference")
}

/// XML 1.0 production [2] `Char`.
fn is_xml_char(code: u32) -> bool {
    matches!(code, 0x9 | 0xA | 0xD | 0x20..=0xD7FF | 0xE000..=0xFFFD | 0x1_0000..=0x10_FFFF)
}

#[cfg(test)]
mod tests;
