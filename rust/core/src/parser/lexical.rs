// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The STEP `/* ... */` comment-skip rule, shared by every scanner that has
//! no reason to answer an unterminated comment differently from the others.
//!
//! [`skip_step_comment`] answers an unterminated `/*` by refusing it: it
//! returns `None`, the same as "not a comment here" from the caller's point
//! of view. That is correct for a scanner walking already-located,
//! well-formed record bytes looking for structure — an unterminated comment
//! there means the input is corrupt, and silently consuming the rest of it
//! is worse than stopping. [`super::scanner::EntityScanner`] and
//! `ifc-lite-geometry`'s `IfcTriangulatedFaceSet` CoordIndex walk both used
//! to hand-roll this and disagreed with each other on exactly this case
//! (issue #3303); both now call this one function.
//!
//! `ifc-lite-export`'s STEP HEADER prescan (`source_header::Lex`) answers the
//! same question differently, on purpose, and that is not the divergence
//! #3303 is about: a header prescan that swallows every later record has
//! lost the schema, so it treats an unterminated `/*` as ordinary text
//! instead of refusing. See the doc comment on `Lex::skip_comment_at` for
//! why that call site needs its own answer. It still calls this function to
//! find where a *closed* comment ends — only the unterminated case is
//! handled differently, and only at that one call site.

/// If a STEP `/* ... */` comment starts at `bytes[i]`, the index just past
/// its closing `*/`.
///
/// Returns `None` when `bytes[i]` doesn't begin a comment, and ALSO when it
/// does but no closing `*/` exists anywhere in `bytes` after it — an
/// unterminated comment is refused rather than silently run to end of input.
/// A caller that needs to tell those two `None` cases apart already knows
/// which one it's in, from having checked `bytes[i..i + 2] == b"/*"` itself
/// before calling (as every call site in this repo does), so the single
/// `Option` return doesn't lose information.
#[inline]
pub fn skip_step_comment(bytes: &[u8], i: usize) -> Option<usize> {
    if bytes.get(i) != Some(&b'/') || bytes.get(i + 1) != Some(&b'*') {
        return None;
    }
    let len = bytes.len();
    let mut p = i + 2;
    while p + 1 < len {
        // Find the next '*'; check whether it's followed by '/'.
        let star = match memchr::memchr(b'*', &bytes[p..]) {
            Some(off) => p + off,
            None => return None, // unterminated comment
        };
        if star + 1 < len && bytes[star + 1] == b'/' {
            return Some(star + 2);
        }
        p = star + 1;
    }
    None // unterminated comment
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closed_comment_skips_to_after_close() {
        let bytes = b"/* hello #77 */rest";
        assert_eq!(skip_step_comment(bytes, 0), Some(15));
        assert_eq!(&bytes[15..], b"rest");
    }

    #[test]
    fn adjacent_asterisks_inside_a_comment_do_not_confuse_the_scan() {
        let bytes = b"/* a ** weird *comment* */tail";
        let end = skip_step_comment(bytes, 0).expect("comment is closed");
        assert_eq!(&bytes[end..], b"tail");
    }

    #[test]
    fn unterminated_comment_is_refused() {
        assert_eq!(skip_step_comment(b"/* never closes", 0), None);
        assert_eq!(skip_step_comment(b"/*", 0), None);
        assert_eq!(skip_step_comment(b"/* trailing star *", 0), None);
    }

    #[test]
    fn not_a_comment_at_all() {
        assert_eq!(skip_step_comment(b"/x not a comment", 0), None);
        assert_eq!(skip_step_comment(b"/", 0), None);
        assert_eq!(skip_step_comment(b"", 0), None);
    }
}
