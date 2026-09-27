// SPDX-License-Identifier: MPL-2.0
//! Unit-name normalisation and the project length-unit lookup
//! (`step-map-unit.ts`), plus `conversionUnitSymbol` (`project-units-symbols.ts`).
//!
//! A regenerated property keeps an explicit unit only when
//! `findLengthUnitReference(normalizeMapUnitName(symbol))` names one of the
//! project's length units; everything else is written `$`. That is the
//! TypeScript exporter's rule, lossy for every non-length unit, and it is
//! ported as-is so the two writers agree on which units survive.

use super::jsval::JsVal;
use super::source::Source;

const SI_PREFIXES: &[&str] = &[
    "FEMTO", "MICRO", "HECTO", "CENTI", "MILLI", "EXA", "PETA", "TERA", "GIGA", "MEGA", "KILO", "DECA",
    "DECI", "NANO", "PICO", "ATTO",
];

/// `conversionUnitSymbol`.
pub(crate) fn conversion_unit_symbol(name: &str) -> String {
    let clean = name.replace('\'', "");
    let clean = clean.trim();
    let symbol = match clean.to_uppercase().as_str() {
        "DEGREE" => "°",
        "GRAD" | "GON" => "gon",
        "MINUTE" => "′",
        "SECOND" => "″",
        "FOOT" | "FEET" => "ft",
        "INCH" => "in",
        "YARD" => "yd",
        "MILE" => "mi",
        "LITRE" | "LITER" => "L",
        "ACRE" => "acre",
        "POUND" | "POUND-MASS" | "LBM" => "lb",
        "POUND-FORCE" | "LBF" => "lbf",
        "OUNCE" => "oz",
        "TON-METRIC" | "TONNE" => "t",
        "PSI" => "psi",
        "BAR" => "bar",
        "KIP" => "kip",
        "MINUTE-TIME" | "MIN" => "min",
        "HOUR" => "h",
        "DAY" => "d",
        "BTU" => "Btu",
        _ => return clean.to_string(),
    };
    symbol.to_string()
}

fn tokens(label: &str) -> Vec<String> {
    label
        .to_uppercase()
        .split(|c: char| !(c.is_ascii_uppercase() || c.is_ascii_digit()))
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

fn is_us_survey_foot(tokens: &[String]) -> bool {
    let is_foot = |t: &String| matches!(t.as_str(), "FOOT" | "FEET" | "FT");
    if tokens.iter().filter(|t| is_foot(t)).count() != 1 {
        return false;
    }
    let rest: Vec<&String> = tokens.iter().filter(|t| !is_foot(t)).collect();
    match rest.as_slice() {
        [one] => one.as_str() == "US" || one.as_str() == "USSURVEY",
        [a, b] => {
            let has = |w: &str| a.as_str() == w || b.as_str() == w;
            has("US") && has("SURVEY")
        }
        _ => false,
    }
}

fn canonical(key: &str) -> Option<String> {
    for spelling in ["METRE", "METER"] {
        if key == spelling {
            return Some("METRE".to_string());
        }
        for prefix in SI_PREFIXES {
            if key == format!("{prefix}{spelling}") {
                return Some(format!("{prefix}METRE"));
            }
        }
    }
    match key {
        "FOOT" | "FEET" => Some("FOOT".to_string()),
        "USSURVEYFOOT" | "USSURVEYFEET" | "USSURVEYFT" | "USFOOT" | "USFEET" | "USFT" | "FTUS" => {
            Some("US SURVEY FOOT".to_string())
        }
        _ => None,
    }
}

/// `normalizeMapUnitName`.
pub(crate) fn normalize_map_unit_name(unit_name: &str) -> String {
    let normalized = unit_name.trim().to_uppercase().split_whitespace().collect::<Vec<_>>().join(" ");
    let toks = tokens(&normalized);
    if toks.is_empty() {
        return normalized;
    }
    if is_us_survey_foot(&toks) {
        return "US SURVEY FOOT".to_string();
    }
    let key = toks.concat();
    if let Some(exact) = canonical(&key) {
        return exact;
    }
    for suffix in ["S", "ES"] {
        if let Some(stem) = key.strip_suffix(suffix) {
            if let Some(singular) = canonical(stem) {
                return singular;
            }
        }
    }
    normalized
}

/// `findLengthUnitReference`: the project's length unit whose name
/// normalises to `preferred`, if any. `is_deleted` is the effective index's
/// tombstone test.
pub(crate) fn find_length_unit_reference(
    preferred: &str,
    src: &Source<'_>,
    is_deleted: &dyn Fn(u32) -> bool,
) -> Option<u32> {
    if preferred.is_empty() {
        return None;
    }
    let project = src.of_type("IFCPROJECT").first().copied()?;
    let (_, attrs) = src.entity(project)?;
    let assignment = attrs.get(8)?.as_num()? as u32;
    if is_deleted(assignment) {
        return None;
    }
    let (_, assignment_attrs) = src.entity(assignment)?;
    let JsVal::Arr(units) = assignment_attrs.first()? else { return None };
    for unit in units {
        let Some(unit_id) = unit.as_num().map(|n| n as u32) else { continue };
        if is_deleted(unit_id) {
            continue;
        }
        let Some((ty, uattrs)) = src.entity(unit_id) else { continue };
        let clean = |v: Option<&JsVal>| v.and_then(JsVal::as_str).map(|s| s.replace('.', "").to_uppercase());
        if clean(uattrs.get(1)).as_deref() != Some("LENGTHUNIT") {
            continue;
        }
        if ty == "IFCSIUNIT" {
            let prefix = clean(uattrs.get(2)).unwrap_or_default();
            let name = clean(uattrs.get(3)).unwrap_or_default();
            if normalize_map_unit_name(&format!("{prefix}{name}")) == preferred {
                return Some(unit_id);
            }
        }
        if ty == "IFCCONVERSIONBASEDUNIT" {
            let name = uattrs.get(2).and_then(JsVal::as_str).map(normalize_map_unit_name).unwrap_or_default();
            if name == preferred {
                return Some(unit_id);
            }
        }
    }
    None
}
