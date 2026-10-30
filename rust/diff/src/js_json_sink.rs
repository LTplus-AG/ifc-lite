// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Serialization sinks for [`JsonValue`] (#8114). The `String` sink is the
//! byte-exact text. The other sinks process the same text without
//! materializing a hole run: its exact UTF-16 length, its stable hash, and a
//! run-length form that compares like the text.
use std::cmp::Ordering;
use crate::JsString;
use crate::utf16::{cmp_code_units, StableHasher};
use super::{write_value, JsonValue};

pub(super) trait JsonSink {
    fn push_str(&mut self, text: &str);
    /// `text`, `count` times over.
    fn push_repeat(&mut self, text: &str, count: u64);
    /// Well-formed JSON.stringify escapes unpaired surrogate code units.
    fn push_json_string(&mut self, value: &JsString) {
        let mut text = String::new();
        value.write_json(&mut text);
        self.push_str(&text);
    }
}
impl JsonSink for String {
    fn push_str(&mut self, text: &str) { String::push_str(self, text); }
    fn push_repeat(&mut self, text: &str, count: u64) {
        for _ in 0..count { String::push_str(self, text); }
    }
    fn push_json_string(&mut self, value: &JsString) { value.write_json(self); }
}

/// JavaScript `string.length` of the text; saturates rather than wraps.
struct Utf16Length(u64);
fn units(text: &str) -> u64 { text.encode_utf16().count() as u64 }
impl JsonSink for Utf16Length {
    fn push_str(&mut self, text: &str) { self.0 = self.0.saturating_add(units(text)); }
    fn push_repeat(&mut self, text: &str, count: u64) {
        self.0 = self.0.saturating_add(units(text).saturating_mul(count));
    }
}
impl JsonSink for StableHasher {
    fn push_json_string(&mut self, value: &JsString) {
        self.write([34]);
        let units = value.units();
        let mut index = 0;
        while index < units.len() {
            let unit = units[index];
            match unit {
                34 | 92 => self.write([92, unit]),
                8 => self.write([92, 98]),
                9 => self.write([92, 116]),
                10 => self.write([92, 110]),
                12 => self.write([92, 102]),
                13 => self.write([92, 114]),
                0xd800..=0xdbff if units.get(index + 1).is_some_and(|u| (0xdc00..=0xdfff).contains(u)) => {
                    self.write([unit, units[index + 1]]);
                    index += 1;
                }
                0..=31 | 0xd800..=0xdfff => {
                    const HEX: &[u8] = b"0123456789abcdef";
                    self.write([92, 117]);
                    self.write([12, 8, 4, 0].map(|shift| u16::from(HEX[((unit >> shift) & 15) as usize])));
                }
                _ => self.write([unit]),
            }
            index += 1;
        }
        self.write([34]);
    }
    fn push_str(&mut self, text: &str) { self.write(text.encode_utf16()); }
    fn push_repeat(&mut self, text: &str, count: u64) {
        for _ in 0..count { self.write(text.encode_utf16()); }
    }
}

/// Exact UTF-16 length of `stringify` (`sort_keys` false) or `stringify_sorted`.
pub(crate) fn utf16_length(value: &JsonValue, sort_keys: bool) -> u64 {
    let mut length = Utf16Length(0);
    write_value(value, sort_keys, &mut length);
    length.0
}

/// `stable_hash(&stringify(value))`, streamed: O(present) memory.
pub(crate) fn stable_hash_json(value: &JsonValue) -> String {
    let mut hasher = StableHasher::default();
    write_value(value, false, &mut hasher);
    hasher.finish()
}

pub(crate) fn has_holes(value: &JsonValue) -> bool {
    match value {
        JsonValue::Holes(count) => *count > 0,
        JsonValue::Array(items) => items.iter().any(has_holes),
        JsonValue::Object(entries) => entries.iter().any(|(_, item)| has_holes(item)),
        _ => false,
    }
}

/// `cmp_code_units(&stringify_sorted(a), &stringify_sorted(b))`. Hole-free
/// values keep that exact text comparison; otherwise both sides compare as
/// run-length code units, so a hole run costs O(1) memory and time.
pub(crate) fn cmp_sorted(a: &JsonValue, b: &JsonValue) -> Ordering {
    if !has_holes(a) && !has_holes(b) {
        return cmp_code_units(&super::stringify_sorted(a), &super::stringify_sorted(b));
    }
    let (mut left, mut right) = (Segments::default(), Segments::default());
    write_value(a, true, &mut left);
    write_value(b, true, &mut right);
    cmp_segments(&left.0, &right.0)
}

/// Literal code units, or one unit sequence repeated a number of times.
#[derive(Debug)]
enum Segment { Units(Vec<u16>), Repeat(Vec<u16>, u64) }
#[derive(Default)]
struct Segments(Vec<Segment>);
impl JsonSink for Segments {
    fn push_str(&mut self, text: &str) {
        if text.is_empty() { return; }
        if let Some(Segment::Units(units)) = self.0.last_mut() {
            units.extend(text.encode_utf16());
        } else {
            self.0.push(Segment::Units(text.encode_utf16().collect()));
        }
    }
    fn push_repeat(&mut self, text: &str, count: u64) {
        if count > 0 && !text.is_empty() { self.0.push(Segment::Repeat(text.encode_utf16().collect(), count)); }
    }
}

/// A position in a segment list: segment, completed repeats, unit offset.
struct Cursor<'a> { segments: &'a [Segment], index: usize, repeat: u64, offset: usize }
impl<'a> Cursor<'a> {
    fn new(segments: &'a [Segment]) -> Self { Self { segments, index: 0, repeat: 0, offset: 0 } }
    fn peek(&self) -> Option<u16> {
        match self.segments.get(self.index)? {
            Segment::Units(units) | Segment::Repeat(units, _) => Some(units[self.offset]),
        }
    }
    fn advance(&mut self) {
        let (units, repeats) = match &self.segments[self.index] {
            Segment::Units(units) => (units, 1),
            Segment::Repeat(units, count) => (units, *count),
        };
        self.offset += 1;
        if self.offset == units.len() {
            self.offset = 0;
            self.repeat += 1;
            if self.repeat == repeats { self.index += 1; self.repeat = 0; }
        }
    }
    /// The unit sequence and remaining repeats, when exactly at a repeat start.
    fn run(&self) -> Option<(&'a [u16], u64)> {
        match self.segments.get(self.index)? {
            Segment::Repeat(units, count) if self.offset == 0 => Some((units, count - self.repeat)),
            _ => None,
        }
    }
    fn skip(&mut self, repeats: u64, remaining: u64) {
        if repeats == remaining { self.index += 1; self.repeat = 0; } else { self.repeat += repeats; }
    }
}
fn cmp_segments(a: &[Segment], b: &[Segment]) -> Ordering {
    let (mut left, mut right) = (Cursor::new(a), Cursor::new(b));
    loop {
        if let (Some((units, rest_a)), Some((other, rest_b))) = (left.run(), right.run()) {
            if units == other {
                let common = rest_a.min(rest_b);
                left.skip(common, rest_a);
                right.skip(common, rest_b);
                continue;
            }
        }
        match (left.peek(), right.peek()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x != y => return x.cmp(&y),
            _ => { left.advance(); right.advance(); }
        }
    }
}
