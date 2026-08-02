// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Canonical resolution of a file's declared units for **display**.
//!
//! Where [`crate::units`] resolves only the LENGTH and PLANEANGLE *scale
//! factors* needed to normalise geometry, this module resolves the file's whole
//! `IfcUnitAssignment` into a per-unit-type table of display symbols + SI scale
//! factors, covering `IfcSIUnit` (with prefixes), `IfcDerivedUnit` (composed,
//! e.g. `m\u{00B3}/s`), `IfcConversionBasedUnit` (\u{00B0}, ft, ...) and
//! `IfcMonetaryUnit`. It also maps a property's IFC measure value type (e.g.
//! `IfcVolumetricFlowRateMeasure`) onto the unit it is shown in.
//!
//! This is the source of truth for unit *display*; the viewer mirrors it in
//! `packages/parser/src/project-units.ts`, pinned by the shared parity vectors
//! in `rust/core/tests/fixtures/unit_symbol_vectors.json`.

pub mod measure;
pub mod symbols;

use std::collections::BTreeMap;

use crate::decoder::EntityDecoder;
pub use measure::{measure_unit, MeasureUnit};
use symbols::{compose_derived, conversion_unit_symbol, si_unit_symbol_and_scale};

/// A resolved display unit: the symbol to render plus the factor that converts a
/// value expressed in this unit to its canonical SI base (`mm` -> `1e-3`,
/// `m\u{00B3}/h` -> `1/3600`, `\u{00B0}` -> `0.01745...`). `si_scale` is `1.0`
/// for units already at the SI base and for monetary units.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedUnit {
    pub symbol: String,
    pub si_scale: f64,
}

impl ResolvedUnit {
    fn new(symbol: impl Into<String>, si_scale: f64) -> Self {
        Self { symbol: symbol.into(), si_scale }
    }
}

/// The set of units a file declares in its `IfcUnitAssignment`, keyed by
/// unit-type token (`"LENGTHUNIT"`, `"VOLUMETRICFLOWRATEUNIT"`, ...). Only the
/// unit-types the file actually declares are present; anything else falls back
/// to the IFC-canonical SI default in [`ProjectUnits::unit_for_measure`].
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProjectUnits {
    by_type: BTreeMap<String, ResolvedUnit>,
    monetary: Option<ResolvedUnit>,
}

impl ProjectUnits {
    /// Resolve the full unit assignment reachable from `project_id`. Never
    /// fails: an absent / malformed assignment yields an empty table (all
    /// measures then fall back to their SI default symbols).
    pub fn resolve(decoder: &mut EntityDecoder, project_id: u32) -> Self {
        let mut units = ProjectUnits::default();
        let Ok(project) = decoder.decode_by_id(project_id) else {
            return units;
        };
        if project.ifc_type.as_str() != "IFCPROJECT" {
            return units;
        }
        // IFCPROJECT attribute 8 = UnitsInContext (IFCUNITASSIGNMENT).
        let Some(units_ref) = project.get(8).and_then(|a| a.as_entity_ref()) else {
            return units;
        };
        let Ok(assignment) = decoder.decode_by_id(units_ref) else {
            return units;
        };
        if assignment.ifc_type.as_str() != "IFCUNITASSIGNMENT" {
            return units;
        }
        // IFCUNITASSIGNMENT.Units (attribute 0) is a list of unit refs. Collect
        // the ids first so we release the borrow on `assignment` before the
        // decoder is borrowed mutably again inside the resolve loop.
        let refs: Vec<u32> = match assignment.get(0).and_then(|a| a.as_list()) {
            Some(list) => list.iter().filter_map(|a| a.as_entity_ref()).collect(),
            None => return units,
        };
        for unit_ref in refs {
            if let Some((unit_type, resolved, monetary)) = resolve_unit_by_ref(decoder, unit_ref) {
                if monetary {
                    units.monetary = Some(resolved);
                } else if let Some(t) = unit_type {
                    // First declaration of a unit-type wins (IFC allows only one
                    // per type anyway); don't let a later duplicate clobber it.
                    units.by_type.entry(t).or_insert(resolved);
                }
            }
        }
        units
    }

    /// The display unit for a property/quantity whose IFC measure value type is
    /// `measure_type` (e.g. `"IfcVolumetricFlowRateMeasure"`). Prefers the
    /// file's declared unit for the measure's unit-type and otherwise falls back
    /// to the IFC-canonical SI default. Returns `None` for dimensionless
    /// measures (ratios, counts) and non-measure value types (labels, ...).
    pub fn unit_for_measure(&self, measure_type: &str) -> Option<ResolvedUnit> {
        match measure_unit(measure_type)? {
            MeasureUnit::Typed { unit_type, default_symbol } => Some(
                self.by_type
                    .get(unit_type)
                    .cloned()
                    .unwrap_or_else(|| ResolvedUnit::new(default_symbol, 1.0)),
            ),
            MeasureUnit::Monetary => self.monetary.clone(),
            MeasureUnit::Dimensionless => None,
        }
    }

    /// The resolved unit the file declares for a raw unit-type token, if any.
    pub fn resolved_for_unit_type(&self, unit_type: &str) -> Option<&ResolvedUnit> {
        self.by_type.get(unit_type)
    }

    /// The resolved monetary (currency) unit, if the file declares one.
    pub fn monetary(&self) -> Option<&ResolvedUnit> {
        self.monetary.as_ref()
    }

    /// Number of declared unit-types (excluding monetary). Test/telemetry aid.
    pub fn declared_len(&self) -> usize {
        self.by_type.len()
    }
}

/// Resolve a single unit entity (referenced from a `IfcUnitAssignment`, or from
/// a per-property / per-quantity `Unit` override). Returns
/// `(unit_type_token, resolved, is_monetary)`.
///
/// Exposed so the per-property `IfcPropertySingleValue.Unit` and per-quantity
/// `IfcPhysicalSimpleQuantity.Unit` overrides can be resolved against the same
/// canonical logic.
pub fn resolve_unit_by_ref(
    decoder: &mut EntityDecoder,
    unit_ref: u32,
) -> Option<(Option<String>, ResolvedUnit, bool)> {
    resolve_unit_by_ref_depth(decoder, unit_ref, 0)
}

/// Max depth for the IFCDERIVEDUNIT -> element -> unit recursion. Real derived
/// units nest ~2 levels; a malformed file can form a reference cycle (an
/// IFCDERIVEDUNIT whose element's Unit points back to it), so cap the recursion
/// to keep it from overflowing the stack, which is an uncatchable abort.
const MAX_UNIT_RESOLVE_DEPTH: u32 = 16;

fn resolve_unit_by_ref_depth(
    decoder: &mut EntityDecoder,
    unit_ref: u32,
    depth: u32,
) -> Option<(Option<String>, ResolvedUnit, bool)> {
    if depth > MAX_UNIT_RESOLVE_DEPTH {
        return None;
    }
    let entity = decoder.decode_by_id(unit_ref).ok()?;
    match entity.ifc_type.as_str() {
        "IFCSIUNIT" => {
            // [1]=UnitType, [2]=Prefix, [3]=Name
            let unit_type = entity.get(1).and_then(|a| a.as_enum()).map(str_token);
            let name = entity.get(3).and_then(|a| a.as_enum())?;
            let prefix = entity
                .get(2)
                .filter(|a| !a.is_null())
                .and_then(|a| a.as_enum());
            let (symbol, scale) = si_unit_symbol_and_scale(name, prefix)?;
            Some((unit_type, ResolvedUnit::new(symbol, scale), false))
        }
        "IFCCONVERSIONBASEDUNIT" => {
            // [1]=UnitType, [2]=Name, [3]=ConversionFactor (IFCMEASUREWITHUNIT)
            let unit_type = entity.get(1).and_then(|a| a.as_enum()).map(str_token);
            let name = entity.get(2).and_then(|a| a.as_string()).unwrap_or("");
            let symbol = conversion_unit_symbol(name);
            let conv_ref = entity.get_ref(3);
            let scale = conv_ref
                .and_then(|r| conversion_factor_scale(decoder, r))
                .unwrap_or(1.0);
            Some((unit_type, ResolvedUnit::new(symbol, scale), false))
        }
        "IFCDERIVEDUNIT" => {
            // [0]=Elements (list of IFCDERIVEDUNITELEMENT), [1]=UnitType
            let unit_type = entity.get(1).and_then(|a| a.as_enum()).map(str_token);
            let elem_refs: Vec<u32> = entity
                .get(0)
                .and_then(|a| a.as_list())
                .map(|l| l.iter().filter_map(|a| a.as_entity_ref()).collect())
                .unwrap_or_default();
            let mut parts: Vec<(String, i32)> = Vec::new();
            let mut scale = 1.0f64;
            for er in elem_refs {
                if let Some((sym, unit_scale, exponent)) =
                    resolve_derived_element(decoder, er, depth)
                {
                    scale *= unit_scale.powi(exponent);
                    parts.push((sym, exponent));
                }
            }
            let symbol = compose_derived(&parts);
            if symbol.is_empty() {
                return None;
            }
            Some((unit_type, ResolvedUnit::new(symbol, scale), false))
        }
        "IFCMONETARYUNIT" => {
            // [0]=Currency (IfcLabel string in IFC4+, IfcCurrencyEnum in IFC2x3).
            let currency = entity
                .get(0)
                .and_then(|a| a.as_string().or_else(|| a.as_enum()))
                .unwrap_or("");
            Some((None, ResolvedUnit::new(currency_symbol(currency), 1.0), true))
        }
        _ => None,
    }
}

/// Resolve one `IFCDERIVEDUNITELEMENT` into `(base_symbol, unit_si_scale, exponent)`.
fn resolve_derived_element(
    decoder: &mut EntityDecoder,
    elem_ref: u32,
    depth: u32,
) -> Option<(String, f64, i32)> {
    let elem = decoder.decode_by_id(elem_ref).ok()?;
    if elem.ifc_type.as_str() != "IFCDERIVEDUNITELEMENT" {
        return None;
    }
    // [0]=Unit (IfcNamedUnit), [1]=Exponent
    let unit_ref = elem.get_ref(0)?;
    let exponent = elem.get(1).and_then(|a| a.as_int()).unwrap_or(1) as i32;
    let (_ut, resolved, _mon) = resolve_unit_by_ref_depth(decoder, unit_ref, depth + 1)?;
    Some((resolved.symbol, resolved.si_scale, exponent))
}

/// The SI scale of an `IFCCONVERSIONBASEDUNIT.ConversionFactor`
/// (`IFCMEASUREWITHUNIT`): the value component expressed in the (possibly
/// prefixed) SI unit component.
fn conversion_factor_scale(decoder: &mut EntityDecoder, measure_ref: u32) -> Option<f64> {
    let measure = decoder.decode_by_id(measure_ref).ok()?;
    if measure.ifc_type.as_str() != "IFCMEASUREWITHUNIT" {
        return None;
    }
    // [0]=ValueComponent, [1]=UnitComponent
    let value = measure.get(0).and_then(|a| a.as_float())?;
    if !(value.is_finite() && value > 0.0) {
        return None;
    }
    // Fold the unit component's own SI scale (e.g. a value stated in millimetres).
    let component_scale = measure
        .get_ref(1)
        .and_then(|r| {
            let comp = decoder.decode_by_id(r).ok()?;
            if comp.ifc_type.as_str() == "IFCSIUNIT" {
                let name = comp.get(3).and_then(|a| a.as_enum())?;
                let prefix = comp.get(2).filter(|a| !a.is_null()).and_then(|a| a.as_enum());
                si_unit_symbol_and_scale(name, prefix).map(|(_, s)| s)
            } else {
                None
            }
        })
        .unwrap_or(1.0);
    Some(value * component_scale)
}

/// Normalise a STEP enum token (`.LENGTHUNIT.`) to a bare uppercase token.
fn str_token(s: &str) -> String {
    s.trim().trim_matches('.').to_ascii_uppercase()
}

/// Friendly currency symbol for a common ISO-4217 code; falls back to the code.
fn currency_symbol(code: &str) -> String {
    let c = code.trim().trim_matches('\'').trim_matches('.').trim();
    match c.to_ascii_uppercase().as_str() {
        "EUR" => "\u{20AC}".to_string(),
        "USD" => "$".to_string(),
        "GBP" => "\u{00A3}".to_string(),
        "JPY" | "CNY" | "RMB" => "\u{00A5}".to_string(),
        "" => "".to_string(),
        _ => c.to_string(),
    }
}

#[cfg(test)]
mod tests;
