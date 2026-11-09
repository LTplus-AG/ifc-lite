// SPDX-License-Identifier: MPL-2.0
//! Names as openNURBS holds them, and the one uniqueness rule every table
//! (sibling layers, materials, an object's user-text keys) shares.

use std::collections::HashSet;

/// A name with no control characters and no `::` (Rhino's path separator;
/// `A::B` as a name collides with child `B` of `A`), trimmed of whitespace and
/// U+200B (openNURBS trims both). `None` when nothing is left. The layer and
/// user-text key rule.
pub(super) fn clean_name(raw: &str) -> Option<String> {
    let mut s: String = raw.chars().filter(|c| !c.is_control()).collect();
    while s.contains("::") {
        s = s.replace("::", ":");
    }
    let s = s.trim_matches(|c: char| c.is_whitespace() || c == '\u{200B}');
    (!s.is_empty()).then(|| s.to_string())
}

/// `name` with a leading `_` when it starts (after leading whitespace, which
/// openNURBS trims) with `(`, `)`, `[`, `]`, `{` or `}`. openNURBS 8.35 stores
/// such a layer as `Layer <n>` and blanks such a material name [ran].
pub(super) fn bracket_safe(name: &str) -> String {
    let start = name.trim_start();
    if start.starts_with(['(', ')', '[', ']', '{', '}']) { format!("_{start}") } else { name.to_string() }
}

/// The key two names collide under. openNURBS compares component names and
/// user-string keys ignoring case, non-ASCII letters included (`Ü` and `ü`
/// are one key). Upper then lower case folds at least every pair it folds;
/// folding a few more only costs an unneeded suffix.
pub(super) fn fold_case(name: &str) -> String {
    if name.is_ascii() { name.to_ascii_lowercase() } else { name.to_uppercase().to_lowercase() }
}

/// Names taken in one openNURBS namespace, compared ignoring case.
#[derive(Default)]
pub(super) struct NameSet {
    /// Case-folded ([`fold_case`]).
    taken: HashSet<String>,
}

impl NameSet {
    /// The first of `candidates` not taken, now taken; each candidate is
    /// folded once. The candidates must not run out: end them with an
    /// unbounded suffix range.
    pub(super) fn claim(&mut self, candidates: impl IntoIterator<Item = String>) -> String {
        candidates
            .into_iter()
            .find(|c| self.taken.insert(fold_case(c)))
            .expect("name candidates end in an unbounded suffix range")
    }

    /// Take the name whose [`fold_case`] form is `folded`, for a caller that
    /// folded it once up front; false when it is already taken.
    pub(super) fn claim_folded(&mut self, folded: &str) -> bool {
        !self.taken.contains(folded) && self.taken.insert(folded.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folding_ignores_case_beyond_ascii() {
        assert_eq!(fold_case("Level 1"), "level 1");
        assert_eq!(fold_case("Ü"), fold_case("ü"));
        assert_eq!(fold_case("STRASSE"), fold_case("Straße"));
    }

    #[test]
    fn the_first_free_candidate_wins_ignoring_case() {
        let mut set = NameSet::default();
        assert_eq!(set.claim(["A".to_string()]), "A");
        fn numbered(base: &str) -> impl Iterator<Item = String> + '_ {
            std::iter::once(base.to_string()).chain((2..).map(move |n| format!("{base} ({n})")))
        }
        assert_eq!(set.claim(numbered("a")), "a (2)");
        assert_eq!(set.claim(numbered("A (2)")), "A (2) (2)");
        assert!(!set.claim_folded("a"));
        assert!(set.claim_folded("b"));
        assert_eq!(set.claim(numbered("B")), "B (2)");
    }
}
