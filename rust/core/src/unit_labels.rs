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
    match prefix {
        "ATTO" => Some(1e-18),
        "FEMTO" => Some(1e-15),
        "PICO" => Some(1e-12),
        "NANO" => Some(1e-9),
        "MICRO" => Some(1e-6),
        "MILLI" => Some(1e-3), // Most common: millimeters
        "CENTI" => Some(1e-2), // Centimeters
        "DECI" => Some(1e-1),  // Decimeters
        "DECA" => Some(1e1),   // Dekameters
        "HECTO" => Some(1e2),  // Hectometers
        "KILO" => Some(1e3),   // Kilometers
        "MEGA" => Some(1e6),
        "GIGA" => Some(1e9),
        "TERA" => Some(1e12),
        "PETA" => Some(1e15),
        "EXA" => Some(1e18),
        _ => None,
    }
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

/// 1200/3937 m — the US survey foot, distinct from the international 0.3048.
const US_SURVEY_FOOT_SCALE: f64 = 0.3048006096;

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
fn is_us_survey_foot_tokens(tokens: &[String]) -> bool {
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
    if matches!(
        key,
        "USSURVEYFOOT" | "USSURVEYFEET" | "USSURVEYFT" | "USFOOT" | "USFEET" | "USFT" | "FTUS"
    ) {
        return Some(US_SURVEY_FOOT_SCALE);
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
        return Some(US_SURVEY_FOOT_SCALE);
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
