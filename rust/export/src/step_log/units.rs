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

/// `conversionUnitSymbol`: the one implementation lives in core (EXPORT-STEP-20).
pub(crate) use ifc_lite_core::project_units::symbols::conversion_unit_symbol;

fn tokens(label: &str) -> Vec<String> {
    label
        .to_uppercase()
        .split(|c: char| !(c.is_ascii_uppercase() || c.is_ascii_digit()))
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

fn canonical(key: &str) -> Option<String> {
    for spelling in ["METRE", "METER"] {
        if key == spelling {
            return Some("METRE".to_string());
        }
        for prefix in ifc_lite_core::SI_PREFIXES {
            if key == format!("{}{spelling}", prefix.name) {
                return Some(format!("{}METRE", prefix.name));
            }
        }
    }
    match key {
        "FOOT" | "FEET" => Some("FOOT".to_string()),
        _ if ifc_lite_core::is_us_survey_foot_key(key) => Some("US SURVEY FOOT".to_string()),
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
    if ifc_lite_core::is_us_survey_foot_tokens(&toks) {
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
