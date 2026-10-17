// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit *labels* and the scales they resolve to.
//!
//! Two readers need the same answer to "what does this unit label mean in
//! metres": [`crate::units`], reading an `IfcSIUnit`/`IfcConversionBasedUnit`
//! declaration, and [`crate::georef`], reading the free-text
//! `ePSet_ProjectedCRS.MapUnit` of the IFC2x3 georeferencing convention. Both
//! tables and the MapUnit label rules live here so the two cannot drift; the
//! `units::` paths are preserved as re-exports.

/// One member of the `IfcSIPrefix` EXPRESS enumeration.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SiPrefix {
    /// The enumeration token without dots (`"MILLI"`).
    pub name: &'static str,
    /// The display symbol that prepends a unit symbol (`"m"`, `"\u{00B5}"`).
    pub symbol: &'static str,
    /// The multiplier (`1e-3`).
    pub factor: f64,
}

const fn prefix(name: &'static str, symbol: &'static str, factor: f64) -> SiPrefix {
    SiPrefix { name, symbol, factor }
}

/// The one `IfcSIPrefix` table (CORE-26, XCUT-6): the multiplier readers
/// ([`try_si_prefix_multiplier`]), the display symbols
/// ([`crate::project_units::symbols::si_prefix_symbol`]) and the exporters'
/// prefix-name checks all derive from these sixteen rows.
pub const SI_PREFIXES: [SiPrefix; 16] = [
    prefix("ATTO", "a", 1e-18),
    prefix("FEMTO", "f", 1e-15),
    prefix("PICO", "p", 1e-12),
    prefix("NANO", "n", 1e-9),
    prefix("MICRO", "\u{00B5}", 1e-6), // micro sign
    prefix("MILLI", "m", 1e-3),         // Most common: millimeters
    prefix("CENTI", "c", 1e-2),         // Centimeters
    prefix("DECI", "d", 1e-1),          // Decimeters
    prefix("DECA", "da", 1e1),          // Dekameters
    prefix("HECTO", "h", 1e2),          // Hectometers
    prefix("KILO", "k", 1e3),           // Kilometers
    prefix("MEGA", "M", 1e6),
    prefix("GIGA", "G", 1e9),
    prefix("TERA", "T", 1e12),
    prefix("PETA", "P", 1e15),
    prefix("EXA", "E", 1e18),
];

/// The [`SI_PREFIXES`] row for a member of the `IfcSIPrefix` EXPRESS
/// enumeration (exact token, no dots), or `None`.
pub fn si_prefix(prefix: &str) -> Option<&'static SiPrefix> {
    SI_PREFIXES.iter().find(|row| row.name == prefix)
}

/// SI Prefix multiplier for a member of the `IfcSIPrefix` EXPRESS
/// enumeration, or `None` when the string is not one of its sixteen members.
///
/// The checked form exists because callers that need to tell "no prefix" from
/// "a prefix I do not recognise" cannot use [`get_si_prefix_multiplier`],
/// which collapses both onto 1.0. Resolving an `ePSet_ProjectedCRS.MapUnit`
/// label is one such caller: answering 1.0 for an unrecognised spelling is a
/// silent wrong answer, where declining to answer defers to the project
/// length unit, which is the documented convention.
#[inline]
pub fn try_si_prefix_multiplier(prefix: &str) -> Option<f64> {
    si_prefix(prefix).map(|row| row.factor)
}

/// SI Prefix multipliers as defined in IFC specification.
/// Maps IfcSIPrefix enum values to their numeric multipliers; an absent or
/// unrecognised prefix means the base unit (metres), i.e. 1.0. Callers that
/// must distinguish those two cases want [`try_si_prefix_multiplier`].
#[inline]
pub fn get_si_prefix_multiplier(prefix: &str) -> f64 {
    try_si_prefix_multiplier(prefix).unwrap_or(1.0)
}

/// Known conversion factors for imperial/conversion-based units to meters
/// These are the standard conversions defined in IFC specification
#[inline]
pub fn get_conversion_based_unit_factor(name: &str) -> Option<f64> {
    match name.to_uppercase().as_str() {
        // Length units to meters
        // The quoted spellings are the doubled-quote STEP escaping: a name
        // attribute written `''FEET''` in the file decodes to the
        // four-character string `'FEET'` and is matched here verbatim. Keep
        // this arm in step with CONVERSION_BASED_UNIT_FACTORS in
        // packages/parser/src/unit-extractor.ts — two length-unit readers that
        // disagree put the model and its map coordinates on different scales.
        "FOOT" | "FEET" | "'FOOT'" | "'FEET'" => Some(0.3048),
        "INCH" | "'INCH'" => Some(0.0254),
        "YARD" | "'YARD'" => Some(0.9144),
        "MILE" | "'MILE'" => Some(1609.344),
        _ => None,
    }
}

/// 1200/3937 m, exactly: the US survey foot, distinct from the international
/// 0.3048. The one definition (CORE-26, EXPORT-STEP-20): the former core copy
/// was truncated to `0.3048006096` (4e-12 relative).
pub const US_SURVEY_FOOT_M: f64 = 1200.0 / 3937.0;

/// Is `key` — an already-folded (alphanumeric, upper-cased) label — one of the
/// glued US-survey-foot spellings? Shared with the exporters' map-unit
/// normaliser so the spelling list has one home.
pub fn is_us_survey_foot_key(key: &str) -> bool {
    matches!(
        key,
        "USSURVEYFOOT" | "USSURVEYFEET" | "USSURVEYFT" | "USFOOT" | "USFEET" | "USFT" | "FTUS"
    )
}

/// The foot/feet spellings a US-survey qualifier may be attached to.
const FOOT_TOKENS: [&str; 3] = ["FOOT", "FEET", "FT"];

/// Order-insensitive recogniser for the separated US-survey foot spellings —
/// `foot (US survey)`, `SURVEY FEET (US)`, `US survey foot`. The glued
/// spellings (`USSURVEYFOOT`, `FTUS`, ...) are matched exactly in
/// [`resolve_exact_unit_label`]; once an exporter puts separators in, the
/// word order varies and gluing alone cannot see it.
///
/// Accepts exactly one foot token plus either `US` (or the glued `USSURVEY`)
/// or both `US` and `SURVEY`. A bare `SURVEY FOOT` without `US` is REFUSED:
/// other national survey feet exist (the Indian and Clarke feet are different
/// ratios), so the qualifier alone does not identify the value.
///
/// Twin of `isUsSurveyFootTokens` in
/// packages/parser/src/georef-extractor.ts.
pub fn is_us_survey_foot_tokens(tokens: &[String]) -> bool {
    let feet = tokens
        .iter()
        .filter(|t| FOOT_TOKENS.contains(&t.as_str()))
        .count();
    if feet != 1 {
        return false;
    }
    let rest: Vec<&str> = tokens
        .iter()
        .map(|t| t.as_str())
        .filter(|t| !FOOT_TOKENS.contains(t))
        .collect();
    match rest.len() {
        1 => rest[0] == "US" || rest[0] == "USSURVEY",
        2 => rest.contains(&"US") && rest.contains(&"SURVEY"),
        _ => false,
    }
}

/// Exact lookup of an already-folded (alphanumeric, upper-cased) unit label.
///
/// The accepted set is DERIVED, not hand-written: the conversion-based length
/// units of the shared table, the glued US-survey foot spellings, and the
/// METRE/METER base spellings carrying any member of the `IfcSIPrefix`
/// EXPRESS enumeration.
fn resolve_exact_unit_label(key: &str) -> Option<f64> {
    if key.is_empty() {
        return None;
    }

    // The US survey foot is a different ratio from the international foot
    // (1200/3937 vs 0.3048), and is spelled several ways in the wild. These
    // are the accepted glued spellings, matched exactly rather than sniffed
    // for; the separated ones go through `is_us_survey_foot_tokens`.
    if is_us_survey_foot_key(key) {
        return Some(US_SURVEY_FOOT_M);
    }

    // Conversion-based length units (FOOT/FEET/INCH/YARD/MILE), from the same
    // table the native IfcConversionBasedUnit path uses.
    if let Some(factor) = get_conversion_based_unit_factor(key) {
        return Some(factor);
    }

    // SI: strip the base-unit spelling, then resolve what remains as an
    // IfcSIPrefix member. An empty remainder is the unprefixed metre.
    for spelling in ["METRE", "METER"] {
        if let Some(prefix) = key.strip_suffix(spelling) {
            if prefix.is_empty() {
                return Some(1.0);
            }
            // `try_`, not `get_`: the infallible form answers 1.0 for an
            // unrecognised prefix, which is the very approximation this
            // function exists to refuse.
            return try_si_prefix_multiplier(prefix);
        }
    }

    None
}

/// Resolve an `ePSet_ProjectedCRS.MapUnit` free-text label to its metre scale.
///
/// `MapUnit` on the ePSet path is exporter free text, so the label is
/// NORMALISED and then matched EXACTLY — never substring-matched.
///
/// What the normalisation accepts:
/// - any case and any separators: `metres`, `Meters`, `US survey foot`,
///   `MILLI-METRE` (letters and digits are kept, everything else dropped);
/// - the two base spellings `METRE` and `METER`, each prefixed by any of the
///   sixteen `IfcSIPrefix` members (`MILLIMETRE` ... `GIGAMETER`);
/// - the conversion-based length units of the shared table (`FOOT`, `FEET`,
///   `INCH`, `YARD`, `MILE`);
/// - one English plural suffix on any of the above, stripped once and then
///   re-matched exactly: `METRES`, `KILOMETERS`, `MILLIMETRES`, `INCHES`,
///   `MILES`;
/// - the US survey foot, glued (`USSURVEYFOOT`, `USFT`, `FTUS`, ...) or
///   separated in any word order (see [`is_us_survey_foot_tokens`]).
///
/// What it still REFUSES (returns `None`, so the ePSet convention defers to
/// the project length unit downstream):
/// - an absent or blank label;
/// - a label that merely CONTAINS a known unit: `SQUARE METRE` is an area,
///   `BANANAMETRE` is not a unit, and neither may borrow the metre's scale;
/// - abbreviations that are not in the table (`M`, `MM`, `MTR`);
/// - a survey foot with no nationality (`SURVEY FOOT`);
/// - anything else, including a plural whose singular is still unknown.
///
/// The exactness is the point. A `contains("METRE")` test is satisfied by
/// MILLIMETRE, CENTIMETRE, KILOMETRE, DECAMETRE, HECTOMETRE and every other
/// prefixed spelling, so a decametre map unit answered 1.0 — a silent 10x
/// error in the CRS scale; the same shape scaled a projected CRS by 1000x in
/// #3274. Normalising a recognisable spelling onto a table entry is not that:
/// the answer is still one exact table hit, and `DECAMETRES` resolves to 10,
/// not to 1. Where no exact answer exists after normalisation, decline rather
/// than approximate: an absent MapUnit is honest and has a defined meaning, a
/// wrong one relocates the model.
///
/// Twin of `inferMapUnitScaleFromLabel` in
/// packages/parser/src/georef-extractor.ts; both are pinned to the shared
/// vectors in rust/core/tests/fixtures/georef_vectors.json.
pub(crate) fn infer_map_unit_scale(label: &str) -> Option<f64> {
    let tokens: Vec<String> = label
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_ascii_uppercase())
        .collect();
    if tokens.is_empty() {
        return None;
    }
    if is_us_survey_foot_tokens(&tokens) {
        return Some(US_SURVEY_FOOT_M);
    }

    let key: String = tokens.concat();
    if let Some(scale) = resolve_exact_unit_label(&key) {
        return Some(scale);
    }

    // One English plural suffix, removed once and re-matched exactly. `ES`
    // covers INCHES, whose singular is not reachable by dropping a single `S`.
    for suffix in ["S", "ES"] {
        if let Some(stem) = key.strip_suffix(suffix) {
            if let Some(scale) = resolve_exact_unit_label(stem) {
                return Some(scale);
            }
        }
    }

    None
}
