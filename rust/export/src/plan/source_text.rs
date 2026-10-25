// SPDX-License-Identifier: MPL-2.0
//! Editing a source record without changing the bytes the edit leaves alone.
//!
//! A STEP file need not be UTF-8 (Latin-1 names are common), but the
//! attribute editor works on `str`. [`apply_edits`] maps every byte of the
//! record, and of each edit, to a char one for one (ASCII to itself, a byte
//! of 0x80 or more to `U+F700 + byte`), edits, and maps back. The mapping is
//! total and the same on both sides, so there is nothing to collide with: a
//! valid UTF-8 character in the record or in the new text is just its bytes.

use std::borrow::Cow;
use std::collections::BTreeMap;

const BASE: u32 = 0xF700;

/// `bytes` as one char per byte; borrowed when they are all ASCII.
fn to_chars(bytes: &[u8]) -> Cow<'_, str> {
    match std::str::from_utf8(bytes) {
        Ok(text) if text.is_ascii() => Cow::Borrowed(text),
        _ => Cow::Owned(bytes.iter().map(|&b| if b < 0x80 { char::from(b) } else { char::from_u32(BASE + u32::from(b)).unwrap_or('\u{FFFD}') }).collect()),
    }
}

/// The bytes [`to_chars`] read.
fn to_bytes(text: &str) -> Vec<u8> {
    text.chars().map(|c| if c.is_ascii() { c as u8 } else { (c as u32 - BASE) as u8 }).collect()
}

/// The record `bytes` with `edits` applied, as bytes. `refused` counts the
/// edits the record cannot take (see `apply_attr_mutations_counted`).
pub(crate) fn apply_edits(bytes: &[u8], edits: &BTreeMap<usize, String>, refused: &mut usize) -> Vec<u8> {
    let edits: BTreeMap<usize, String> = edits.iter().map(|(&idx, text)| (idx, to_chars(text.as_bytes()).into_owned())).collect();
    to_bytes(&crate::step_text::apply_attr_mutations_counted(&to_chars(bytes), &edits, refused))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mapping_round_trips_any_bytes() {
        let all: Vec<u8> = (0..=255).collect();
        assert_eq!(to_bytes(&to_chars(&all)), all);
        let mixed: &[u8] = b"'Gr\xF6sse \xC3\xA4 \xEF\x9F\xA9 \xE2\x82' \xFF";
        assert_eq!(to_bytes(&to_chars(mixed)), mixed);
        assert!(matches!(to_chars(b"plain"), Cow::Borrowed(_)));
    }

    /// Record text and new text holding U+F7E9 (EF 9F A9) or Latin-1 bytes
    /// come out as the bytes they went in as.
    #[test]
    fn edits_keep_every_byte_of_the_record_and_of_the_new_text() {
        let edits = BTreeMap::from([(1usize, "'a\u{F7E9}b'".to_string())]);
        let out = apply_edits(b"#1=IFCX('Gr\xF6sse',$,'\xEF\x9F\xA9');", &edits, &mut 0);
        assert_eq!(out, b"#1=IFCX('Gr\xF6sse','a\xEF\x9F\xA9b','\xEF\x9F\xA9');");
        let edits = BTreeMap::from([(2usize, "$".to_string())]);
        assert_eq!(apply_edits(b"#1=IFCX('Gr\xF6sse',$,'\xEF\x9F\xA9');", &edits, &mut 0), b"#1=IFCX('Gr\xF6sse',$,$);");
    }
}
