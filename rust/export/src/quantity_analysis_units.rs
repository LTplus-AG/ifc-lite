// SPDX-License-Identifier: MPL-2.0
//! Unit resolution and physical-value comparison for authored quantities.

use ifc_lite_core::{EntityDecoder, ProjectUnits, ResolvedUnit, resolve_unit_by_ref};

use super::{AuthoredQuantity, QuantityUnit};

pub(super) fn express_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "Length" => Some("IfcQuantityLength"),
        "Area" => Some("IfcQuantityArea"),
        "Volume" => Some("IfcQuantityVolume"),
        "Count" => Some("IfcQuantityCount"),
        "Number" => Some("IfcQuantityNumber"),
        "Weight" => Some("IfcQuantityWeight"),
        "Time" => Some("IfcQuantityTime"),
        _ => None,
    }
}

fn quantity_measure(kind: &str) -> Option<(&'static str, &'static str)> {
    match kind {
        "IfcQuantityLength" => Some(("IfcLengthMeasure", "LENGTHUNIT")),
        "IfcQuantityArea" => Some(("IfcAreaMeasure", "AREAUNIT")),
        "IfcQuantityVolume" => Some(("IfcVolumeMeasure", "VOLUMEUNIT")),
        "IfcQuantityWeight" => Some(("IfcMassMeasure", "MASSUNIT")),
        "IfcQuantityTime" => Some(("IfcTimeMeasure", "TIMEUNIT")),
        _ => None,
    }
}

fn display_unit(unit: ResolvedUnit, source: &'static str, unit_id: Option<u32>,
    unit_type: Option<String>) -> QuantityUnit {
    QuantityUnit { symbol: unit.symbol, si_scale: unit.si_scale, source, unit_id, UnitType: unit_type }
}

pub(super) fn resolve_quantity_unit(
    decoder: &mut EntityDecoder, project_units: &ProjectUnits, kind: &str,
    unit_id: Option<u32>, invalid_unit_ref: bool,
) -> (Option<QuantityUnit>, Option<String>) {
    if invalid_unit_ref {
        return (None, Some("Unit is not an entity reference".into()));
    }
    if let Some(unit_id) = unit_id {
        return match (quantity_measure(kind), resolve_unit_by_ref(decoder, unit_id)) {
            (None, Some((unit_type, resolved, false)))
                if matches!(kind, "IfcQuantityCount" | "IfcQuantityNumber") =>
                    (Some(display_unit(resolved, "explicit", Some(unit_id), unit_type)), None),
            (Some((_, expected)), Some((Some(actual), resolved, false))) if actual == expected =>
                (Some(display_unit(resolved, "explicit", Some(unit_id), Some(actual))), None),
            _ => (None, Some(format!("unsupported or dimensionally mismatched Unit #{unit_id}"))),
        };
    }
    if matches!(kind, "IfcQuantityCount" | "IfcQuantityNumber") {
        return (Some(QuantityUnit { symbol: "1".into(), si_scale: 1.0,
            source: "dimensionless", unit_id: None, UnitType: None }), None);
    }
    if let Some((measure, unit_type)) = quantity_measure(kind) {
        return match project_units.unit_for_measure(measure) {
            Some(resolved) => {
                let source = if project_units.resolved_for_unit_type(unit_type).is_some() {
                    "project"
                } else { "si_default" };
                (Some(display_unit(resolved, source, None, Some(unit_type.into()))), None)
            }
            None => (None, Some(format!("unresolved project unit for {kind}"))),
        };
    }
    (None, Some(format!("unsupported quantity kind {kind}")))
}

pub(super) fn same_physical_value(a: &AuthoredQuantity, b: &AuthoredQuantity) -> bool {
    if a.kind != b.kind { return false; }
    let (Some(a_unit), Some(b_unit)) = (&a.unit, &b.unit) else { return false; };
    if matches!(a.kind, "IfcQuantityCount" | "IfcQuantityNumber") {
        // The shared resolver exposes UnitType but does not certify a named
        // unit's dimensional exponents. Only the same source unit entity proves
        // equivalence for these leaf types, whose explicit unit is unrestricted.
        let same_dimension = match (a_unit.source, b_unit.source) {
            ("dimensionless", "dimensionless") => true,
            ("explicit", "explicit") =>
                a_unit.unit_id.is_some() && a_unit.unit_id == b_unit.unit_id,
            _ => false,
        };
        if !same_dimension { return false; }
    }
    let a_si = a.value * a_unit.si_scale;
    let b_si = b.value * b_unit.si_scale;
    a_si.is_finite() && b_si.is_finite() &&
        (a_si - b_si).abs() <= 1e-12 + 1e-9 * a_si.abs().max(b_si.abs())
}
