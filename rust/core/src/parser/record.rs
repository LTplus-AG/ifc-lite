// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! [`StepRecord`]: the zero-copy view of one `#id = KEYWORD ( ... ) ;` record
//! that every raw-byte reader reads through (F4-3, CORE-1, CORE-10).
//!
//! Until F4-3 each fast reader found "its" attribute with its own prelude: skip
//! to the first `(`, skip to the second `(`, take the first `#` after it,
//! slice from `=` to `(`. None of them knew about trivia or literals, so a
//! comment (`/* (9.) */(1.,2.,3.)`) or a `#` inside a string moved the read.
//! The head is read here once, with core's trivia rule, and the attributes
//! are [`StepListItems`], so a comment is trivia and a literal is a region
//! everywhere. Nothing is allocated: every accessor returns a slice of the
//! record, or writes into the caller's buffer.
//!
//! The accessors are "tolerant": they answer `None` for what they cannot
//! read and never guess. Grammar that the full decode refuses is refused
//! here too (a number goes through [`parse_step_real`], an id through
//! [`parse_express_id`](crate::express_id::parse_express_id)).

use super::numeric_literal::parse_step_real;
use super::scanner::{attribute_is_present, StepListItems};
use super::{is_step_space, skip_step_comment, skip_step_trivia};
use crate::express_id::{parse_express_id, parse_express_id_prefix};
use std::borrow::Cow;

/// The head of a record and its attribute list, read lazily.
///
/// [`Self::parse`] only LOCATES the `(` that opens the attributes (outside
/// comments); the instance name and the keyword are read from the head when
/// asked for ([`Self::id`], [`Self::keyword`]), because the hot readers want
/// neither.
#[derive(Debug, Clone, Copy)]
pub struct StepRecord<'a> {
    bytes: &'a [u8],
    /// Offset of the `#` that starts the head.
    head: usize,
    /// Offset of the `(` that opens the attribute list.
    open: usize,
    /// Whether the head holds a comment (the rare case; [`Self::keyword_is`]
    /// reads such a head properly instead of by its tail).
    commented: bool,
}

fn is_keyword_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// The digit run at the start of `bytes` and its express id: nine digits or
/// fewer cannot overflow (the shape of every real file), anything longer is
/// the checked walk of [`parse_express_id_prefix`].
#[inline(always)]
fn read_id(bytes: &[u8]) -> (usize, Option<u32>) {
    let (mut n, mut id) = (0usize, 0u32);
    while n < 9 && n < bytes.len() && bytes[n].is_ascii_digit() {
        id = id * 10 + u32::from(bytes[n] - b'0');
        n += 1;
    }
    if n == 0 {
        return (0, None);
    }
    if n < 9 || !bytes.get(n).is_some_and(u8::is_ascii_digit) {
        return (n, Some(id));
    }
    parse_express_id_prefix(bytes)
}

/// `#n` and nothing else: the one reference spelling. `#+5`, `#12abc` and
/// `# 5` are not references, and an id above `u32::MAX` is refused, not
/// wrapped (#3421).
#[inline]
pub fn parse_ref(item: &[u8]) -> Option<u32> {
    let digits = item.strip_prefix(b"#")?;
    if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    parse_express_id(digits)
}

impl<'a> StepRecord<'a> {
    /// Locate the attribute list of `record`, a `#id = KEYWORD ( ... )`
    /// record with trivia (whitespace and `/* ... */`) wherever STEP allows
    /// it: the first `(` outside a comment, in a head that starts with `#`.
    /// O(head), no allocation.
    ///
    /// `None` when the record does not start with `#`, has no `(`, or a
    /// comment in the head never closes, and for a complex instance
    /// (`#1=(IFCA(...)IFCB(...))`: the `(` directly follows the `=`), which
    /// has no single attribute list. The head's spelling is NOT checked here:
    /// [`Self::id`] and [`Self::keyword`] say whether it is `#digits =
    /// KEYWORD`.
    #[inline]
    pub fn parse(record: &'a [u8]) -> Option<Self> {
        let head = if record.first() == Some(&b'#') { 0 } else { skip_step_trivia(record, 0)? };
        (record.get(head) == Some(&b'#')).then_some(())?;
        let mut from = head;
        let mut commented = false;
        let open = loop {
            let at = from + memchr::memchr2(b'(', b'/', &record[from..])?;
            if record[at] == b'(' {
                break at;
            }
            from = match record.get(at + 1) {
                Some(b'*') => {
                    commented = true;
                    skip_step_comment(record, at)?
                }
                _ => at + 1,
            };
        };
        let mut before = open;
        while before > head && is_step_space(record[before - 1]) {
            before -= 1;
        }
        (record[before - 1] != b'=').then_some(Self { bytes: record, head, open, commented })
    }

    /// The instance name, `n` of `#n`. `None` when the head is not
    /// `#digits` then `=` (or the id is past `u32::MAX`).
    pub fn id(&self) -> Option<u32> {
        let (digits, id) = parse_express_id_prefix(&self.bytes[self.head + 1..self.open]);
        let eq = skip_step_trivia(self.bytes, self.head + 1 + digits)?;
        (digits > 0 && eq < self.open && self.bytes[eq] == b'=').then_some(())?;
        id
    }

    /// The keyword's bytes, as written: the run of `[A-Za-z0-9_]` between the
    /// `=` and the `(`, trivia on either side. `None` when the head is not
    /// `#id = KEYWORD`.
    pub fn keyword_bytes(&self) -> Option<&'a [u8]> {
        let (digits, _) = parse_express_id_prefix(&self.bytes[self.head + 1..self.open]);
        let eq = skip_step_trivia(self.bytes, self.head + 1 + digits)?;
        (digits > 0 && eq < self.open && self.bytes[eq] == b'=').then_some(())?;
        let start = skip_step_trivia(self.bytes, eq + 1)?;
        let len = self.bytes[start..self.open].iter().position(|&b| !is_keyword_byte(b)).unwrap_or(self.open - start);
        (len > 0 && skip_step_trivia(self.bytes, start + len)? == self.open).then(|| &self.bytes[start..start + len])
    }

    /// The keyword as written (STEP keyword case is not significant: compare
    /// with [`keyword_eq`](super::keyword_eq), or resolve it with
    /// [`ifc_type_from_keyword`](crate::ifc_type_from_keyword)).
    pub fn keyword(&self) -> Option<&'a str> {
        self.keyword_bytes().and_then(|k| std::str::from_utf8(k).ok())
    }

    /// Whether the head ends in the keyword `upper` (ASCII upper case),
    /// ignoring case, as a whole identifier. No scan of the head: for the
    /// per-bound reads that only ask "is this IFCFACEOUTERBOUND".
    #[inline]
    pub fn keyword_is(&self, upper: &[u8]) -> bool {
        if self.commented {
            return self.keyword_bytes().is_some_and(|k| k.eq_ignore_ascii_case(upper));
        }
        let mut end = self.open;
        while end > self.head && is_step_space(self.bytes[end - 1]) {
            end -= 1;
        }
        let Some(start) = end.checked_sub(upper.len()).filter(|&s| s > self.head) else {
            return false;
        };
        // The upper-case spelling every exporter writes is one memcmp.
        let tail = &self.bytes[start..end];
        (tail == upper || tail.eq_ignore_ascii_case(upper)) && !is_keyword_byte(self.bytes[start - 1])
    }

    /// The top-level attributes, each trimmed of trivia.
    #[inline]
    pub fn attrs(&self) -> StepListItems<'a> {
        StepListItems::at(self.bytes, self.open + 1)
    }

    /// Attribute `i` (0-based) as written. `None` past the last one, or when
    /// a literal, list or comment before the end of it never closes.
    #[inline]
    pub fn attr(&self, i: usize) -> Option<&'a [u8]> {
        self.attrs().nth(i)
    }

    /// Whether attribute `i` holds a value: it exists, is not `$` and is not
    /// an empty slot, and the record's list closes. `false` for everything
    /// the record does not settle.
    pub fn is_present(&self, i: usize) -> bool {
        attribute_is_present(self.attrs(), i)
    }

    /// Attribute `i` when it is exactly one reference (`#n`).
    #[inline]
    pub fn ref_at(&self, i: usize) -> Option<u32> {
        if i != 0 {
            return parse_ref(self.attr(i)?);
        }
        // Attribute 0 starts right after the head's `(`: read the reference
        // in place, then require what ends an attribute, without the item walk.
        let value = &self.bytes[self.open + 1..];
        let at = skip_step_trivia(value, 0)?;
        (value.get(at) == Some(&b'#')).then_some(())?;
        let (digits, id) = read_id(&value[at + 1..]);
        let end = skip_step_trivia(value, at + 1 + digits)?;
        matches!(value.get(end), Some(b',' | b')')).then_some(())?;
        id
    }

    /// Attribute 0 as a reference and attribute 1 as an enumeration (without
    /// its dots), read in one pass: the shape of `IfcFaceBound`, on the
    /// geometry hot path. `None` when attribute 0 is not exactly one
    /// reference; the enumeration is `None` when attribute 1 is absent, `$`
    /// or not `.NAME.`.
    #[inline]
    pub fn ref_and_enum(&self) -> Option<(u32, Option<&'a [u8]>)> {
        let value = &self.bytes[self.open + 1..];
        let at = skip_step_trivia(value, 0)?;
        (value.get(at) == Some(&b'#')).then_some(())?;
        let (digits, id) = read_id(&value[at + 1..]);
        let id = id?;
        let mut i = skip_step_trivia(value, at + 1 + digits)?;
        match value.get(i)? {
            b')' => return Some((id, None)),
            b',' => i = skip_step_trivia(value, i + 1)?,
            _ => return None,
        }
        let name = value[i..].strip_prefix(b".").and_then(|rest| {
            let len = rest.iter().position(|&b| !is_keyword_byte(b))?;
            (len > 0 && rest[len] == b'.').then_some(&rest[..len])
        });
        Some((id, name))
    }

    /// Attribute `i` when it is a reference, or a list whose first item is
    /// one: what the face and shell readers want of a `Bounds` slot that may
    /// be either. A `$` is `None`, never the next attribute's reference.
    pub fn first_ref_at(&self, i: usize) -> Option<u32> {
        let item = self.attr(i)?;
        match item.first()? {
            b'#' => parse_ref(item),
            b'(' => parse_ref(StepListItems::of_list(item)?.next()?),
            _ => None,
        }
    }

    /// Replace `out` with the references of the list in attribute `i`, in
    /// authored order. EVERY item must be one reference and the list must
    /// close: a list with any other item (an id above `u32::MAX`, a nested
    /// value, a number) is `None` with `out` empty, because a loop or shell
    /// with one face missing is a different solid (D3). `()` is `Some` with
    /// `out` empty.
    pub fn ref_list_at(&self, i: usize, out: &mut Vec<u32>) -> Option<()> {
        out.clear();
        let read = self.try_each_ref_at(i, |id| {
            out.push(id);
            true
        });
        if read.is_none() {
            out.clear();
        }
        read
    }

    /// [`Self::ref_list_at`] without the buffer: `f` is called with each
    /// reference in order and returns whether to go on. `None` when the
    /// attribute is not a list of nothing but references that closes, or
    /// when `f` stops the read; `f` may already have seen some of the items.
    ///
    /// One pass over the list, with the tight loop the fast readers had
    /// before F4-3 (they sit on the geometry hot path), but with the grammar
    /// settled: trivia is skipped wherever it may sit and nothing but `#n`,
    /// `,` and `)` is accepted.
    #[inline]
    pub fn try_each_ref_at(&self, i: usize, mut f: impl FnMut(u32) -> bool) -> Option<()> {
        // Attribute 0 starts right after the head's `(`, so it needs no item
        // walk; the reader stops at the list's own `)`.
        let value = if i == 0 { &self.bytes[self.open + 1..] } else { self.attr(i)? };
        let open = skip_step_trivia(value, 0)?;
        (value.get(open) == Some(&b'(')).then_some(())?;
        let list = &value[open + 1..];
        let mut at = skip_step_trivia(list, 0)?;
        if list.get(at) == Some(&b')') {
            return Some(());
        }
        loop {
            (list.get(at) == Some(&b'#')).then_some(())?;
            let (digits, id) = read_id(&list[at + 1..]);
            f(id?).then_some(())?;
            at += 1 + digits;
            // Trivia is rare between items: the byte straight after the id
            // is almost always the `,` or `)`.
            if list.get(at).is_some_and(|&b| is_step_space(b) || b == b'/') {
                at = skip_step_trivia(list, at)?;
            }
            match list.get(at)? {
                b')' => return Some(()),
                b',' => {
                    at += 1;
                    if list.get(at).is_some_and(|&b| is_step_space(b) || b == b'/') {
                        at = skip_step_trivia(list, at)?;
                    }
                }
                _ => return None,
            }
        }
    }

    /// Attribute `i` as a `REAL`/`INTEGER` literal. A value `f64` cannot hold
    /// (`1.E400`) is `None`, as is anything that is not exactly one literal.
    #[inline]
    pub fn real_at(&self, i: usize) -> Option<f64> {
        parse_step_real(self.attr(i)?)
    }

    /// Attribute `i` as a point: a list of two or three numbers, `z` zero for
    /// two. The shared point grammar, comments as trivia.
    #[inline]
    pub fn point_at(&self, i: usize) -> Option<(f64, f64, f64)> {
        // The coordinate reader stops at the list's own `)`, so attribute 0
        // is read in place.
        let value = if i == 0 { &self.bytes[self.open + 1..] } else { self.attr(i)? };
        let open = skip_step_trivia(value, 0)?;
        (value.get(open) == Some(&b'(')).then_some(())?;
        let list = &value[open + 1..];
        let (point, used) = crate::decoder::parse_point_coordinates_end(list, |_| true)?;
        // The attribute ends at the point list's `)`: a `;` or anything else
        // there is a record the full decode refuses.
        let end = skip_step_trivia(list, used)?;
        match list.get(end) {
            Some(b',' | b')') => Some(point),
            None => (i != 0).then_some(point),
            Some(_) => None,
        }
    }

    /// Attribute `i` as a string literal, decoded
    /// ([`decode_step_literal`](crate::step_encoding::decode_step_literal)).
    /// `$`, `*` and anything that is not a literal are `None`. Borrowed
    /// unless the literal holds `''` or `\`.
    #[inline]
    pub fn string_at(&self, i: usize) -> Option<Cow<'a, str>> {
        crate::step_encoding::decode_step_literal(self.attr(i)?)
    }

    /// Attribute `i` as an enumeration, without its dots: `.T.` is `b"T"`.
    pub fn enum_at(&self, i: usize) -> Option<&'a [u8]> {
        let inner = self.attr(i)?.strip_prefix(b".")?.strip_suffix(b".")?;
        (!inner.is_empty() && inner.iter().all(|&b| is_keyword_byte(b))).then_some(inner)
    }
}

#[cfg(test)]
#[path = "record_tests.rs"]
mod tests;
