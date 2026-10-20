// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Literal-index attribute-read scanner behind `positional_read_ratchet`
//! (G-F3e, #7780). The workspace has no `syn`, so this reuses the
//! comment/string/char masking of [`super::fn_scan::mask`], blanks every item
//! under `#[cfg(test)]` / `#[test]`, and matches the call shapes that read a
//! STEP attribute by a bare integer:
//!
//!  * a method (or function) in [`ACCESSORS`] whose only argument is an
//!    integer literal: `.get(3)`, `.get_ref(5)`, `.ref_at(2)`, ...;
//!  * `nth_attr*(.., N)` / `nth_attribute_is_present(.., N)`, whose LAST
//!    argument is the index;
//!  * `attributes[N]`.
//!
//! A literal on a plain slice (`parts.get(0)`) matches too: the scanner cannot
//! know the receiver, and the allowlist counts what it sees. A genuine
//! non-attribute read is marked `// not-an-attribute` on its line; the marker
//! is counted and printed separately, so review sees every one.
//!
//! A named constant (`get(IDX)`) is not a literal and is not counted; the
//! point of the gate is that a new read names its attribute through
//! `slot::<Entity>::<ATTR>`.

use super::fn_scan::mask;

/// Methods whose one argument is an attribute index.
pub const ACCESSORS: &[&str] = &[
    "get",
    "get_ref",
    "get_refs",
    "get_float",
    "get_string",
    "get_list",
    "is_present",
    // F3e-0b typed accessors: a bare literal still compiles (it infers
    // `usize`), so it is counted like the untyped reads.
    "attr",
    "ref_at",
    "ref_list_at",
    "real_at",
    "int_at",
    "string_at",
    "enum_at",
    "logical_at",
    "binary_at",
    "list_at",
];

/// Marker that exempts one line, counted separately.
pub const MARKER: &str = "not-an-attribute";

/// One literal-index read.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct Read {
    /// 1-based line.
    pub line: usize,
    /// The matched call, e.g. `get_ref(5)`.
    pub text: String,
}

/// What a file holds: the reads that count and the marked ones.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Reads {
    pub counted: Vec<Read>,
    pub marked: Vec<Read>,
}

fn is_ident_start(c: char) -> bool {
    c == '_' || c.is_alphabetic()
}

fn is_ident_char(c: char) -> bool {
    c == '_' || c.is_alphanumeric()
}

/// `true` when `arg` (already trimmed) is an integer literal: decimal, hex,
/// octal or binary, with `_` separators and an optional integer suffix.
pub fn is_int_literal(arg: &str) -> bool {
    let body = arg.trim();
    let mut chars = body.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_digit() {
        return false;
    }
    let (digits, radix_ok) = match body.get(..2) {
        Some("0x") | Some("0X") => (&body[2..], true),
        Some("0o") | Some("0O") | Some("0b") | Some("0B") => (&body[2..], true),
        _ => (body, false),
    };
    let suffix_at = if radix_ok {
        // A hex literal's own letters are digits; only a trailing `u*`/`i*` suffix is dropped.
        digits.rfind(['u', 'i']).filter(|&at| at > 0)
    } else {
        digits.find(|c: char| !(c.is_ascii_digit() || c == '_'))
    };
    let (number, suffix) = match suffix_at {
        Some(at) => (&digits[..at], &digits[at..]),
        None => (digits, ""),
    };
    let number_ok = !number.is_empty()
        && number.chars().all(|c| c.is_ascii_hexdigit() || c == '_')
        && number.chars().any(|c| c != '_');
    let suffix_ok = suffix.is_empty()
        || matches!(
            suffix,
            "u8" | "u16" | "u32" | "u64" | "u128" | "usize" | "i8" | "i16" | "i32" | "i64" | "i128" | "isize"
        );
    number_ok && suffix_ok
}

/// Blank every item under a `#[cfg(test)]` / `#[test]` attribute: from the
/// attribute through the item's closing `}` (or its terminating `;`).
fn blank_test_items(c: &mut [char]) {
    let mut i = 0;
    while i < c.len() {
        if c[i] != '#' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        if c.get(j) == Some(&'!') {
            j += 1;
        }
        if c.get(j) != Some(&'[') {
            i += 1;
            continue;
        }
        let (mut k, mut depth) = (j, 0usize);
        while k < c.len() {
            match c[k] {
                '[' => depth += 1,
                ']' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            k += 1;
        }
        let text: String = c[j + 1..k.min(c.len())].iter().filter(|x| !x.is_whitespace()).collect();
        let inner = c.get(i + 1) == Some(&'!');
        if inner || !(text == "test" || text.starts_with("cfg(test)")) {
            i = k + 1;
            continue;
        }
        // The item: skip to the first `{` or `;` at bracket depth 0 and take its extent.
        let (mut p, mut brackets) = (k + 1, 0usize);
        let end = loop {
            match c.get(p) {
                None => break c.len(),
                Some('(' | '[') => brackets += 1,
                Some(')' | ']') => brackets = brackets.saturating_sub(1),
                Some(';') if brackets == 0 => break p + 1,
                Some('{') if brackets == 0 => {
                    let mut braces = 0usize;
                    while p < c.len() {
                        match c[p] {
                            '{' => braces += 1,
                            '}' => {
                                braces -= 1;
                                if braces == 0 {
                                    break;
                                }
                            }
                            _ => {}
                        }
                        p += 1;
                    }
                    break (p + 1).min(c.len());
                }
                _ => {}
            }
            p += 1;
        };
        for ch in c.iter_mut().take(end).skip(i) {
            if *ch != '\n' {
                *ch = ' ';
            }
        }
        i = end;
    }
}

/// Split the argument text of a call at top-level commas.
fn split_args(args: &str) -> Vec<&str> {
    let (mut depth, mut start, mut out) = (0usize, 0usize, Vec::new());
    for (at, ch) in args.char_indices() {
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                out.push(&args[start..at]);
                start = at + 1;
            }
            _ => {}
        }
    }
    out.push(&args[start..]);
    out
}

/// Index just past the `)` closing the `(` at `open`, or `None` if unbalanced.
fn close_paren(c: &[char], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (at, ch) in c.iter().enumerate().skip(open) {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(at);
                }
            }
            _ => {}
        }
    }
    None
}

/// Every literal-index attribute read in production code of `src`.
pub fn scan(src: &str) -> Reads {
    let mut c = mask(src);
    blank_test_items(&mut c);
    let original: Vec<&str> = src.lines().collect();
    let mut reads = Reads::default();
    let mut line = 1usize;
    let mut i = 0usize;
    while i < c.len() {
        let ch = c[i];
        if ch == '\n' {
            line += 1;
            i += 1;
            continue;
        }
        if !(is_ident_start(ch) && (i == 0 || !is_ident_char(c[i - 1]))) {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < c.len() && is_ident_char(c[j]) {
            j += 1;
        }
        let word: String = c[i..j].iter().collect();
        let mut k = j;
        while k < c.len() && c[k].is_whitespace() {
            k += 1;
        }
        let found = if word == "attributes" && c.get(k) == Some(&'[') {
            // `attributes[N]`
            c[k..].iter().position(|x| *x == ']').and_then(|close| {
                let inner: String = c[k + 1..k + close].iter().collect();
                is_int_literal(&inner).then(|| (format!("attributes[{}]", inner.trim()), k + close))
            })
        } else if c.get(k) == Some(&'(') {
            let is_method = {
                let mut b = i;
                while b > 0 && c[b - 1].is_whitespace() {
                    b -= 1;
                }
                b > 0 && c[b - 1] == '.'
            };
            let nth = word.starts_with("nth_attr");
            if (is_method && ACCESSORS.contains(&word.as_str())) || nth {
                close_paren(&c, k).and_then(|close| {
                    let inner: String = c[k + 1..close].iter().collect();
                    let args = split_args(&inner);
                    let index = if nth { args.last().copied() } else { (args.len() == 1).then(|| args[0]) };
                    index
                        .filter(|arg| is_int_literal(arg))
                        .map(|arg| (format!("{word}({})", arg.trim()), close))
                })
            } else {
                None
            }
        } else {
            None
        };
        if let Some((text, end)) = found {
            let read = Read { line, text };
            let marked = original.get(line - 1).is_some_and(|l| l.contains(MARKER));
            if marked {
                reads.marked.push(read);
            } else {
                reads.counted.push(read);
            }
            // Keep scanning inside the call's arguments (nested reads), from after the name.
            let _ = end;
        }
        i = j;
    }
    reads
}
