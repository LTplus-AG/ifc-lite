// SPDX-License-Identifier: MPL-2.0
//! Quote-aware byte scanning shared by the source-header record readers.

/// ASCII whitespace per ISO 10303-21.
///
/// Spelled out rather than `u8::is_ascii_whitespace`, which excludes vertical
/// tab. The TypeScript counterpart accepts it, as did the older Rust reader.
fn is_step_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | b'\x0B' | b'\x0C')
}

/// A monotonically advancing scan of one byte buffer.
///
/// Once a `*/` search fails, no later comment opener can have a closer, so
/// remembering that result keeps malformed-input scanning linear.
pub(crate) struct Lex<'a> {
    bytes: &'a [u8],
    no_closer: bool,
    /// `*/` searches performed. At most one can fail.
    pub(crate) searches: u32,
}

impl<'a> Lex<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Self {
        Lex {
            bytes,
            no_closer: false,
            searches: 0,
        }
    }

    /// If a `/* ... */` comment starts at `bytes[i]`, return the index just
    /// past it. An unterminated opener is ordinary text, not a comment.
    fn skip_comment_at(&mut self, i: usize) -> Option<usize> {
        if self.bytes.get(i) != Some(&b'/') || self.bytes.get(i + 1) != Some(&b'*') {
            return None;
        }
        if self.no_closer {
            return None;
        }
        self.searches += 1;
        match ifc_lite_core::skip_step_comment(self.bytes, i) {
            Some(end) => Some(end),
            None => {
                self.no_closer = true;
                None
            }
        }
    }

    /// If a string literal or comment starts at `bytes[i]`, return the index
    /// just past it. Doubled apostrophes remain inside the literal.
    pub(crate) fn skip_lexical_at(&mut self, i: usize) -> Option<usize> {
        if self.bytes.get(i)? == &b'\'' {
            let mut p = i + 1;
            while p < self.bytes.len() {
                if self.bytes[p] != b'\'' {
                    p += 1;
                } else if self.bytes.get(p + 1) == Some(&b'\'') {
                    p += 2;
                } else {
                    return Some(p + 1);
                }
            }
            return Some(self.bytes.len());
        }
        self.skip_comment_at(i)
    }

    /// Advance past whitespace and closed comments.
    pub(crate) fn skip_trivia(&mut self, mut i: usize) -> usize {
        loop {
            while i < self.bytes.len() && is_step_space(self.bytes[i]) {
                i += 1;
            }
            match self.skip_comment_at(i) {
                Some(end) => i = end,
                None => return i,
            }
        }
    }
}

fn is_ident(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Find the opening parenthesis of an exact record keyword outside
/// literals/comments, ignoring ASCII case.
pub(crate) fn find_record_open(haystack: &[u8], keyword: &[u8]) -> Option<usize> {
    if keyword.is_empty() || keyword.len() > haystack.len() {
        return None;
    }
    let mut lex = Lex::new(haystack);
    let last_start = haystack.len() - keyword.len();
    let mut i = 0;
    while i <= last_start {
        if let Some(end) = lex.skip_lexical_at(i) {
            i = end;
            continue;
        }
        let end = i + keyword.len();
        let bounded = (i == 0 || !is_ident(haystack[i - 1]))
            && (end == haystack.len() || !is_ident(haystack[end]));
        if bounded
            && haystack[i..end]
                .iter()
                .zip(keyword)
                .all(|(a, b)| a.eq_ignore_ascii_case(b))
        {
            let open = lex.skip_trivia(end);
            if haystack.get(open) == Some(&b'(') {
                return Some(open);
            }
        }
        i += 1;
    }
    None
}

/// Locate an exact section marker such as `ENDSEC;` or `DATA;`.
///
/// An identifier boundary plus trivia and a semicolon prevent an embedded
/// substring such as the `DATA` in `METADATA;` from ending the header.
pub(crate) fn find_section_marker(haystack: &[u8], keyword: &[u8]) -> Option<usize> {
    if keyword.is_empty() || keyword.len() > haystack.len() {
        return None;
    }
    let mut lex = Lex::new(haystack);
    let last_start = haystack.len() - keyword.len();
    let mut i = 0;
    while i <= last_start {
        if let Some(end) = lex.skip_lexical_at(i) {
            i = end;
            continue;
        }
        let before_is_ident =
            i > 0 && (haystack[i - 1].is_ascii_alphanumeric() || haystack[i - 1] == b'_');
        let matches = !before_is_ident
            && haystack[i..i + keyword.len()]
                .iter()
                .zip(keyword)
                .all(|(a, b)| a.eq_ignore_ascii_case(b));
        if matches {
            let after = lex.skip_trivia(i + keyword.len());
            if haystack.get(after) == Some(&b';') {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}
