// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Case-insensitive comparison of a STEP keyword against an uppercase literal.
//!
//! [`EntityScanner::next_entity`](super::EntityScanner::next_entity) hands back
//! the keyword bytes exactly as the file wrote them: `IFCWALL`, `IfcWall` and
//! `ifcwall` all come back verbatim. ISO 10303-21 says keyword case is not
//! significant, so a call site that compares that slice with `==`,
//! `starts_with` or `ends_with` against an uppercase literal silently drops
//! every record of a lowercase- or CamelCase-keyword file. #4497 fixed two
//! such sites; a sweep afterwards found the same comparison hand-written at
//! dozens more across five crates. These helpers are that rule in one place.
//! The literal passed as `upper` is written in uppercase, and a debug build
//! asserts it. That is a house convention, not a correctness need: the fold
//! is symmetric, so a lowercase literal would still match in release.
//!
//! [`find_keyword`] is the whole-file twin, for the "does this file mention
//! `IFCFOO` at all" probes that let the common no-such-entity file skip a
//! full scan. It replaces `memchr::memmem::find(content, b"IFCFOO")`, which
//! is case-sensitive for the same reason, and it is the general form of the
//! `IFCPROJECT(` probe `ifc_lite_processing::prepass::find_ifcproject_keyword`
//! used to hand-roll. `memmem` has no case-insensitive mode, so this
//! prefilters ONE byte of the needle with `memchr2` (both cases, still SIMD)
//! and verifies the rest with an ASCII case-insensitive compare. Which byte
//! is the whole cost: every anchor hit is a ~10 ns loop exit and re-entry,
//! so the anchor must be the letter that fires least. `I` is the worst
//! choice in this alphabet (every IFC keyword starts with it and GUIDs are
//! full of it): anchoring `IFCPROJECT(` on `I` cost 7.6-13.1 ms on a 20 MB
//! project-less file against 0.33-0.36 ms on `J`. The ranking below was
//! measured on five fixtures from 35 MB to 342 MB (upper+lower counts per
//! letter, median rank); with it, an absent-needle probe runs 1.5-3x behind
//! the case-sensitive `memmem` it replaces, and per-record `keyword_eq`
//! chains cost about 1.3 ns per record more than a `match` on `==`.

/// True when the raw keyword `raw` spells `upper` under STEP's
/// case-insensitive keyword rule. `upper` must be uppercase ASCII.
#[inline]
pub fn keyword_eq(raw: &str, upper: &str) -> bool {
    debug_assert_upper(upper.as_bytes());
    raw.eq_ignore_ascii_case(upper)
}

/// [`keyword_eq`] for a prefix: true when `raw` begins with `upper`, case
/// folded. `upper` must be uppercase ASCII.
#[inline]
pub fn keyword_starts_with(raw: &str, upper: &str) -> bool {
    debug_assert_upper(upper.as_bytes());
    raw.len() >= upper.len() && raw.as_bytes()[..upper.len()].eq_ignore_ascii_case(upper.as_bytes())
}

/// [`keyword_eq`] for a suffix: true when `raw` ends with `upper`, case
/// folded. `upper` must be uppercase ASCII.
#[inline]
pub fn keyword_ends_with(raw: &str, upper: &str) -> bool {
    debug_assert_upper(upper.as_bytes());
    raw.len() >= upper.len()
        && raw.as_bytes()[raw.len() - upper.len()..].eq_ignore_ascii_case(upper.as_bytes())
}

/// Byte offset of the first case-folded occurrence of `upper` in `content`,
/// anywhere (not only at a record's keyword position): the whole-file
/// "is this entity present at all" prefilter. `upper` must be uppercase ASCII
/// and non-empty.
///
/// A hit inside a string literal is a false positive that costs the caller
/// one scan it would otherwise have skipped, the same trade the
/// case-sensitive `memmem` probe it replaces already made.
pub fn find_keyword(content: &[u8], upper: &[u8]) -> Option<usize> {
    debug_assert!(!upper.is_empty(), "find_keyword needs a non-empty needle");
    debug_assert_upper(upper);
    let anchor = rarest_letter_offset(upper);
    // Folded here rather than trusted from the assert: a lowercase needle in
    // release would otherwise search for the same byte twice and skip every
    // uppercase occurrence.
    let anchor_upper = upper[anchor].to_ascii_uppercase();
    let anchor_lower = anchor_upper.to_ascii_lowercase();
    let mut search_from = 0usize;
    loop {
        let rel = memchr::memchr2(anchor_upper, anchor_lower, content.get(search_from..)?)?;
        let hit = search_from + rel;
        search_from = hit + 1;
        let Some(candidate) = hit.checked_sub(anchor) else {
            continue;
        };
        let end = candidate + upper.len();
        if end <= content.len() && content[candidate..end].eq_ignore_ascii_case(upper) {
            return Some(candidate);
        }
    }
}

/// Uppercase letters ordered from rarest to commonest in IFC STEP content
/// (keywords, enumerations, GUIDs and strings together), median rank over
/// five fixtures (35 MB to 342 MB, `memchr2` count of both cases per letter).
/// A heuristic for choosing the anchor byte only: correctness never depends
/// on it. Punctuation is deliberately absent: `(` and `=` are commoner than
/// every letter but `E I T A N L`.
const LETTERS_RAREST_FIRST: &[u8; 26] = b"JZKQWXVHMBGDYUSPLRNOFTACIE";

/// Offset in `upper` of the letter that should fire least often in a file;
/// byte 0 when the needle has no ASCII letter at all.
fn rarest_letter_offset(upper: &[u8]) -> usize {
    let rank = |b: u8| LETTERS_RAREST_FIRST.iter().position(|&l| l == b);
    upper
        .iter()
        .enumerate()
        .filter_map(|(i, &b)| rank(b).map(|r| (r, i)))
        .min()
        .map_or(0, |(_, i)| i)
}

#[inline]
fn debug_assert_upper(upper: &[u8]) {
    debug_assert!(
        !upper.iter().any(u8::is_ascii_lowercase),
        "STEP keyword literal must be uppercase: {}",
        String::from_utf8_lossy(upper)
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eq_folds_only_the_raw_side() {
        assert!(keyword_eq("IFCWALL", "IFCWALL"));
        assert!(keyword_eq("IfcWall", "IFCWALL"));
        assert!(keyword_eq("ifcwall", "IFCWALL"));
        assert!(!keyword_eq("IFCWALLTYPE", "IFCWALL"));
        assert!(!keyword_eq("IFCWAL", "IFCWALL"));
    }

    #[test]
    fn prefix_and_suffix_fold_case() {
        assert!(keyword_starts_with("IfcPropertySingleValue", "IFCPROPERTY"));
        assert!(!keyword_starts_with("IfcProp", "IFCPROPERTY"));
        assert!(keyword_ends_with("IfcWallType", "TYPE"));
        assert!(keyword_ends_with("ifcdoorstyle", "STYLE"));
        assert!(!keyword_ends_with("TYP", "TYPE"));
    }

    #[test]
    fn find_keyword_hits_any_casing_and_misses_absent() {
        let content = b"#1=IfcWall('a');\n#2=ifcindexedcolourmap($);\n#3=IFCDOOR('b');\n";
        assert_eq!(find_keyword(content, b"IFCINDEXEDCOLOURMAP"), Some(20));
        assert_eq!(find_keyword(content, b"IFCWALL"), Some(3));
        assert_eq!(find_keyword(content, b"IFCDOOR"), Some(47));
        assert_eq!(find_keyword(content, b"IFCWINDOW"), None);
        assert_eq!(find_keyword(b"", b"IFCWALL"), None);
    }

    /// The anchor may sit past a hit whose candidate start would be negative,
    /// or so late that the needle would run off the end; both must be skipped,
    /// not panic or match.
    #[test]
    fn find_keyword_handles_anchor_near_the_edges() {
        // 'J' at offset 0: candidate = 0 - 6 underflows, skip.
        assert_eq!(find_keyword(b"J", b"IFCPROJECT"), None);
        // Needle would run past the end of content.
        assert_eq!(find_keyword(b"IFCPROJ", b"IFCPROJECT"), None);
        assert_eq!(find_keyword(b"xxIFCPROJECT", b"IFCPROJECT"), Some(2));
    }

    #[test]
    fn rarest_letter_prefers_j_over_i() {
        assert_eq!(rarest_letter_offset(b"IFCPROJECT("), 6);
        assert_eq!(rarest_letter_offset(b"123("), 0);
    }
}
