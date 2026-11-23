// SPDX-License-Identifier: MPL-2.0
//! Conversion between IFC2X3 IfcTimeMeasure and IFC4 IfcDuration.

use ifc_lite_core::parser::parse_step_real;

pub(super) fn decimal_seconds(token: &str) -> Option<String> {
    parse_step_real(token.as_bytes())?.is_finite().then_some(())?;
    let negative = token.starts_with('-');
    let token = token.strip_prefix(['-', '+']).unwrap_or(token);
    let (mantissa, power) = token.split_once(['e', 'E']).unwrap_or((token, "0"));
    let power = power.parse::<i32>().ok().filter(|p| (-324..=324).contains(p))?;
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let mut digits = format!("{whole}{fraction}");
    let point = whole.len().saturating_add_signed(power as isize);
    let padding = (power as isize).unsigned_abs().saturating_sub(whole.len());
    if power < 0 && padding > 0 {
        digits = format!("{}{digits}", "0".repeat(padding));
    }
    if point > digits.len() {
        digits.push_str(&"0".repeat(point - digits.len()));
    }
    let (whole, fraction) = digits.split_at(point);
    let whole = whole.trim_start_matches('0');
    let whole = if whole.is_empty() { "0" } else { whole };
    let fraction = fraction.trim_end_matches('0');
    let sign = if negative && (whole != "0" || !fraction.is_empty()) { "-" } else { "" };
    let radix = if fraction.is_empty() { "" } else { "." };
    Some(format!("{sign}{whole}{radix}{fraction}"))
}

pub(super) fn from_seconds(token: &str) -> Option<String> {
    let decimal = decimal_seconds(token)?;
    let (sign, decimal) = decimal.strip_prefix('-').map_or(("", decimal.as_str()), |n| ("-", n));
    Some(format!("'{sign}PT{decimal}S'"))
}

fn digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

fn seconds_number(text: &str, fractional: bool) -> Option<f64> {
    let valid = match text.split_once('.') {
        Some((whole, fraction)) => fractional && digits(whole) && digits(fraction),
        None => digits(text),
    };
    valid.then(|| text.parse::<f64>().ok()).flatten()
}

fn clock_seconds(mut time: &str) -> Option<f64> {
    if time.is_empty() {
        return None;
    }
    let mut total = 0.0;
    for (unit, scale) in [('H', 3600.0), ('M', 60.0), ('S', 1.0)] {
        if let Some((value, rest)) = time.split_once(unit) {
            total += seconds_number(value, rest.is_empty())? * scale;
            time = rest;
        }
    }
    time.is_empty().then_some(total)
}

pub(super) fn to_seconds(token: &str) -> Option<String> {
    let text = token.strip_prefix('\'')?.strip_suffix('\'')?;
    let (sign, text) = text.strip_prefix('-').map_or((1.0, text), |rest| (-1.0, rest));
    let text = text.strip_prefix('P')?;
    let total = if let Some(weeks) = text.strip_suffix('W') {
        seconds_number(weeks, true)? * 604800.0
    } else {
        let (date, time) = text.split_once('T').map_or((text, None), |(d, t)| (d, Some(t)));
        let days = if date.is_empty() && time.is_some() { 0.0 } else {
            seconds_number(date.strip_suffix('D')?, time.is_none())?
        };
        days * 86400.0 + time.map_or(Some(0.0), clock_seconds)?
    };
    total.is_finite().then(|| crate::step_log::format_step_real(sign * total))
}

pub(super) const TIME_UNIT_WARNING: &str = "Work-control duration conversion assumed seconds despite a non-second project TIMEUNIT. The exported duration or total float may have changed (#11192).";

pub(super) fn has_non_second_project_time_unit(content: &[u8]) -> bool {
    use ifc_lite_core::{slot, AttributeValue, EntityDecoder, EntityScanner, IfcType};
    let mut projects = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, ty, _, _)) = projects.next_entity() {
        if !ty.eq_ignore_ascii_case("IFCPROJECT") {
            continue;
        }
        let Some(assignment) = decoder.decode_by_id(id).ok()
            .filter(|project| project.ifc_type == IfcType::IfcProject)
            .and_then(|project| project.ref_at(slot::IfcProject::UNITS_IN_CONTEXT))
        else {
            continue;
        };
        let Some(units) = decoder.decode_by_id(assignment).ok()
            .filter(|assignment| assignment.ifc_type == IfcType::IfcUnitAssignment)
            .and_then(|assignment| assignment.ref_list_at(slot::IfcUnitAssignment::UNITS))
        else {
            continue;
        };
        if units.into_iter().any(|id| decoder.decode_by_id(id).is_ok_and(|unit| {
            unit.ifc_type.is_subtype_of(IfcType::IfcNamedUnit)
                && unit.enum_at(slot::IfcNamedUnit::UNIT_TYPE).is_some_and(|t| t.eq_ignore_ascii_case("TIMEUNIT"))
                && !(unit.ifc_type == IfcType::IfcSIUnit
                    && matches!(unit.attr(slot::IfcSIUnit::PREFIX), Some(AttributeValue::Null))
                    && unit.enum_at(slot::IfcSIUnit::NAME).is_some_and(|name| name.eq_ignore_ascii_case("SECOND")))
        })) {
            return true;
        }
    }
    false
}
