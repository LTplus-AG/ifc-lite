// SPDX-License-Identifier: MPL-2.0
//! The one way the export plan reads a source record's bytes as text and
//! writes that record back.
//!
//! A STEP file need not be UTF-8 (Latin-1 names are common), but the plan
//! edits records as `str`. [`decode`] keeps valid UTF-8 as it is and maps each
//! byte that is not part of a valid sequence to a private-use character
//! (`U+F700 + byte`) in a [`SourceText`]. Only a [`SourceText`] can be turned
//! back into bytes ([`SourceText::to_bytes`]), and the only edit entry,
//! [`apply_edits`], splices the caller's new slot text in as bytes after that,
//! so text a caller supplies never meets the byte mapping and a character it
//! holds can never be mistaken for an escaped byte. A record the plan does
//! not edit is written as its source bytes and never decoded for output.

use std::borrow::Cow;
use std::collections::BTreeMap;

const BASE: u32 = 0xF700;

fn escaped(c: char) -> Option<u8> {
    let c = c as u32;
    (BASE + 0x80..=BASE + 0xFF).contains(&c).then(|| (c - BASE) as u8)
}

fn holds_escape(text: &str) -> bool {
    text.chars().any(|c| escaped(c).is_some())
}

/// A source record's text, as [`decode`] read it. The only text that may be
/// mapped back to bytes.
pub(crate) struct SourceText<'a>(Cow<'a, str>);

impl<'a> SourceText<'a> {
    /// The text, for reading.
    pub(crate) fn into_text(self) -> Cow<'a, str> {
        self.0
    }

    /// The bytes this text was read from, when it has not been edited since.
    #[cfg(test)]
    pub(crate) fn to_bytes(&self) -> Cow<'_, [u8]> {
        encode(&self.0)
    }
}

/// `bytes` as text, borrowed when they are valid UTF-8.
pub(crate) fn decode(bytes: &[u8]) -> SourceText<'_> {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return SourceText(Cow::Borrowed(text));
    }
    let mut out = String::with_capacity(bytes.len() + 8);
    for chunk in bytes.utf8_chunks() {
        out.push_str(chunk.valid());
        out.extend(chunk.invalid().iter().map(|&b| char::from_u32(BASE + u32::from(b)).unwrap_or('\u{FFFD}')));
    }
    SourceText(Cow::Owned(out))
}

/// [`decode`], or `None` when the record already holds a character the
/// mapping would turn into a byte, so editing it could not be undone exactly.
fn decode_exact(bytes: &[u8]) -> Option<SourceText<'_>> {
    let holds_escape = bytes.utf8_chunks().any(|c| holds_escape(c.valid()));
    (!holds_escape).then(|| decode(bytes))
}

fn encode(text: &str) -> Cow<'_, [u8]> {
    if !holds_escape(text) {
        return Cow::Borrowed(text.as_bytes());
    }
    let mut out = Vec::with_capacity(text.len());
    let mut buf = [0u8; 4];
    for c in text.chars() {
        match escaped(c) {
            Some(b) => out.push(b),
            None => out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes()),
        }
    }
    Cow::Owned(out)
}

/// The record `bytes` with `edits` applied, as bytes: source bytes the edits
/// do not touch are kept exactly, and each edit's text is spliced in as
/// given. `None` when the record cannot be edited without changing bytes it
/// should keep (it holds text that looks like an escaped byte).
pub(crate) fn apply_edits(bytes: &[u8], edits: &BTreeMap<usize, String>, refused: &mut usize) -> Option<Vec<u8>> {
    let raw = decode_exact(bytes)?.0;
    // Edit text goes in as placeholders absent from the record, so the record
    // is mapped back to bytes without any of it.
    let mut marker = String::from("\u{1}");
    while raw.contains(&marker) {
        marker.push('\u{1}');
    }
    let slot = |idx: usize| format!("{marker}{idx}{marker}");
    let placeholders: BTreeMap<usize, String> = edits.keys().map(|&idx| (idx, slot(idx))).collect();
    let edited = crate::step_text::apply_attr_mutations_counted(&raw, &placeholders, refused);
    let mut out = encode(&edited).into_owned();
    for (idx, text) in edits {
        let token = slot(*idx);
        if let Some(at) = out.windows(token.len()).position(|w| w == token.as_bytes()) {
            out.splice(at..at + token.len(), text.bytes());
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_any_bytes_and_borrows_utf8() {
        let mixed: &[u8] = b"'Gr\xF6sse \xC3\xA4 \xE2\x82' \xFF";
        assert_eq!(&*decode(mixed).to_bytes(), mixed);
        assert!(matches!(decode("plain ä".as_bytes()).0, Cow::Borrowed(_)));
        assert_eq!(&*decode(&[0x80, 0xBF, 0xC0]).to_bytes(), &[0x80, 0xBF, 0xC0]);
    }

    /// Valid UTF-8 that looks like an escaped byte (U+F7E9) must not read as
    /// editable text, or it would be written back as the single byte E9.
    #[test]
    fn text_that_collides_with_an_escape_is_not_exact() {
        let valid = "a\u{F7E9}b".as_bytes();
        assert_eq!(valid, [b'a', 0xEF, 0x9F, 0xA9, b'b']);
        assert!(decode_exact(valid).is_none());
        assert!(decode_exact(b"a\xF6\xEF\x9F\xA9").is_none());
        assert!(decode_exact(b"Gr\xF6sse").is_some());
    }

    /// New slot text is spliced as it is, whatever characters it holds.
    #[test]
    fn edit_text_is_never_mapped_back_to_bytes() {
        let edits = BTreeMap::from([(1usize, "'a\u{F7E9}b'".to_string())]);
        let out = apply_edits(b"#1=IFCX('Gr\xF6sse',$,$);", &edits, &mut 0).unwrap();
        assert_eq!(out, b"#1=IFCX('Gr\xF6sse','a\xEF\x9F\xA9b',$);");
    }
}
