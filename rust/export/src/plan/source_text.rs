// SPDX-License-Identifier: MPL-2.0
//! The one way the export plan reads a source record's bytes as text and
//! writes that text back.
//!
//! A STEP file need not be UTF-8 (Latin-1 names are common), but the plan
//! edits records as `str`. [`decode`] keeps valid UTF-8 as it is and maps each
//! byte that is not part of a valid sequence to a private-use character
//! (`U+F700 + byte`); [`encode`] maps those characters back to the original
//! bytes. A record the plan never edits therefore round-trips byte for byte,
//! and an edit or a copy of a record keeps the bytes it did not touch. The
//! only loss is a source that itself holds a character in `U+F780..=U+F7FF`.

use std::borrow::Cow;

const BASE: u32 = 0xF700;

fn escaped(c: char) -> Option<u8> {
    let c = c as u32;
    (BASE + 0x80..=BASE + 0xFF).contains(&c).then(|| (c - BASE) as u8)
}

/// Whether `text` holds a character [`encode`] would turn into a byte.
pub(crate) fn holds_escape(text: &str) -> bool {
    text.chars().any(|c| escaped(c).is_some())
}

/// `bytes` as text, borrowed when they are valid UTF-8.
pub(crate) fn decode(bytes: &[u8]) -> Cow<'_, str> {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(bytes.len() + 8);
    for chunk in bytes.utf8_chunks() {
        out.push_str(chunk.valid());
        out.extend(chunk.invalid().iter().map(|&b| char::from_u32(BASE + u32::from(b)).unwrap_or('\u{FFFD}')));
    }
    Cow::Owned(out)
}

/// [`decode`], or `None` when the record already holds a character
/// [`encode`] would turn into a byte, so editing it could not be undone
/// exactly. Only an edited record is read this way.
pub(crate) fn decode_exact(bytes: &[u8]) -> Option<Cow<'_, str>> {
    let holds_escape = bytes.utf8_chunks().any(|c| holds_escape(c.valid()));
    (!holds_escape).then(|| decode(bytes))
}

/// The bytes of text produced by [`decode`] and edited since.
pub(crate) fn encode(text: &str) -> Cow<'_, [u8]> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_any_bytes_and_borrows_utf8() {
        let mixed: &[u8] = b"'Gr\xF6sse \xC3\xA4 \xE2\x82' \xFF";
        assert_eq!(&*encode(&decode(mixed)), mixed);
        assert!(matches!(decode("plain ä".as_bytes()), Cow::Borrowed(_)));
        assert!(matches!(encode("plain ä"), Cow::Borrowed(_)));
        assert_eq!(&*encode(&decode(&[0x80, 0xBF, 0xC0])), &[0x80, 0xBF, 0xC0]);
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
}
