// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Identifiers for the Ladybug Tools exporters (HBJSON and DFJSON).
//!
//! honeybee-schema and dragonfly-schema both declare `IDdBaseModel.identifier` as
//! `^[.A-Za-z0-9_-]+$` with a length of 1 to 100. That is the strictest identifier
//! rule either schema has: energy objects (materials, constructions) accept a looser
//! pattern under the same 100-character cap, so one rule that satisfies the base
//! model satisfies all of them. Honeybee's own `clean_string` maps the same set.
//!
//! The USD/IFCX prim-name grammar (`usd::fmt`, `ifc5`) is a different one and is not
//! routed through here.

/// The `max_length` honeybee-schema and dragonfly-schema put on every identifier.
pub(crate) const LADYBUG_IDENTIFIER_MAX: usize = 100;

fn is_ladybug_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')
}

/// `s` as a Ladybug identifier: every character outside `[.A-Za-z0-9_-]` becomes `_`,
/// and the result is cut to [`LADYBUG_IDENTIFIER_MAX`]. An empty `s` gives `fallback`.
pub(crate) fn ladybug_identifier(s: &str, fallback: &str) -> String {
    ladybug_identifier_with_suffix(s, fallback, "")
}

/// Like [`ladybug_identifier`], but `suffix` is kept whole and only the sanitized `s`
/// is cut, so a distinguishing tail (a thickness, a counter) survives truncation.
///
/// `suffix` must already be valid Ladybug text and shorter than the cap.
pub(crate) fn ladybug_identifier_with_suffix(s: &str, fallback: &str, suffix: &str) -> String {
    debug_assert!(suffix.chars().all(is_ladybug_char) && suffix.len() < LADYBUG_IDENTIFIER_MAX);
    debug_assert!(!fallback.is_empty() && fallback.chars().all(is_ladybug_char));
    let budget = LADYBUG_IDENTIFIER_MAX - suffix.len();
    let source = if s.is_empty() { fallback } else { s };
    // Every mapped character is ASCII, so the character count is the byte length.
    let mut out: String =
        source.chars().map(|c| if is_ladybug_char(c) { c } else { '_' }).take(budget).collect();
    out.push_str(suffix);
    out
}

/// The room identifier for piece `piece` of `IfcSpace` `#express_id`.
///
/// A space modelled as several extruded items yields one room per item. The first
/// keeps `R<id>`, so a single-item space (the common case) is unchanged; later ones
/// are `R<id>_<k>`. `_` can never follow the digits of another `R<id>`, so no two
/// spaces can collide. HBJSON and DFJSON both name rooms here, so the same piece has
/// the same identifier in both exports.
pub(crate) fn space_room_identifier(express_id: u32, piece: u32) -> String {
    if piece == 0 {
        format!("R{express_id}")
    } else {
        format!("R{express_id}_{piece}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_to_the_honeybee_character_set_and_keeps_dots() {
        assert_eq!(ladybug_identifier("Tower.v2", "model"), "Tower.v2");
        assert_eq!(ladybug_identifier("a b-c_d", "model"), "a_b-c_d");
        // One `_` per character, not per byte.
        assert_eq!(ladybug_identifier("Bürogebäude", "model"), "B_rogeb_ude");
        assert_eq!(ladybug_identifier("", "model"), "model");
    }

    #[test]
    fn truncates_to_the_schema_cap_and_keeps_the_suffix_whole() {
        let long = "é".repeat(300);
        assert_eq!(ladybug_identifier(&long, "m").len(), LADYBUG_IDENTIFIER_MAX);
        let id = ladybug_identifier_with_suffix(&"a".repeat(300), "m", "_120mm");
        assert_eq!(id.len(), LADYBUG_IDENTIFIER_MAX);
        assert!(id.ends_with("a_120mm"));
    }

    #[test]
    fn piece_zero_keeps_the_historic_room_identifier() {
        assert_eq!(space_room_identifier(42, 0), "R42");
        assert_eq!(space_room_identifier(42, 1), "R42_1");
        assert_ne!(space_room_identifier(4, 21), space_room_identifier(42, 1));
    }
}
