// SPDX-License-Identifier: MPL-2.0
//! The units an Add's property and quantity values carry: a unit record in
//! the source, or a new `IfcSIUnit` written once per plan for each distinct
//! prefix and name. A child of `add`, beside `add_assoc.rs`, whose
//! [`Shared`] it builds through.

use ifc_lite_core::project_units::{measure_unit, MeasureUnit};

use crate::plan::add_assoc_types::{NewPropertySet, PropertyValue, ValueUnit};
use crate::plan::attrs::attribute_index;
use crate::plan::tessellation::Emit;
use crate::plan::types::PsetKind;

use super::assoc::{new_record, Shared, SharedKey, Target};
use super::AddState;

/// A new `IfcSIUnit`: prefix, name, and the unit type the name measures.
pub(super) type NewSi = (Option<String>, String, &'static str);

/// Per set, per property: the unit its value carries, if any.
pub(super) type CheckedUnits = Vec<Vec<Option<Target<NewSi>>>>;

impl AddState<'_, '_> {
    /// The unit of every value in `psets`, refusing one the value cannot
    /// carry: a unit on a value that is not a measure, a unit of the wrong
    /// kind for the measure, or a quantity's unit that is not a named unit.
    pub(super) fn check_units(&self, psets: &[NewPropertySet]) -> Result<CheckedUnits, String> {
        let mut out = Vec::with_capacity(psets.len());
        for set in psets {
            let mut units = Vec::with_capacity(set.properties.len());
            for p in &set.properties {
                let Some(unit) = &p.unit else {
                    units.push(None);
                    continue;
                };
                let what = format!("{}.{}", set.name, p.name);
                let PropertyValue::Measure { measure_type, .. } = &p.value else {
                    return Err(format!("{what}: a unit needs a measure value"));
                };
                let (target, unit_class, unit_type) = match unit {
                    ValueUnit::Existing(r) => {
                        let (id, c) = self.lookup(r)?;
                        if !["IFCNAMEDUNIT", "IFCDERIVEDUNIT", "IFCMONETARYUNIT"].iter().any(|t| self.is_a(&c, t)) {
                            return Err(format!("{what}: unit {r} is {c}, not a unit"));
                        }
                        let unit_type = attribute_index(self.schema, &c, "UnitType")
                            .and_then(|i| crate::step_text::attribute_of(&self.index.raw_line(id)?, i))
                            .map(|v| v.trim().trim_matches('.').to_ascii_uppercase());
                        (Target::Existing(id), c, unit_type)
                    }
                    ValueUnit::Si { prefix, name } => {
                        let name = name.to_ascii_uppercase();
                        let prefix = prefix.as_ref().map(|p| p.to_ascii_uppercase());
                        let unit_type = si_unit_type(&name).ok_or_else(|| format!("{what}: {name} is not an IfcSIUnitName"))?;
                        if let Some(p) = prefix.as_deref().filter(|p| ifc_lite_core::unit_labels::si_prefix(p).is_none()) {
                            return Err(format!("{what}: {p} is not an IfcSIPrefix"));
                        }
                        (Target::New((prefix, name, unit_type)), "IFCSIUNIT".to_string(), Some(unit_type.to_string()))
                    }
                };
                if set.kind == PsetKind::Quantity && !self.is_a(&unit_class, "IFCNAMEDUNIT") {
                    return Err(format!("{what}: a quantity's unit must be a named unit, not {unit_class}"));
                }
                let monetary = unit_class == "IFCMONETARYUNIT";
                // A length, area, volume, weight or time quantity's own rule
                // names its unit type exactly; a property's user-defined or
                // unreadable unit type passes, and a count has no rule.
                let quantity = set.kind == PsetKind::Quantity;
                let fits = match measure_unit(measure_type) {
                    Some(MeasureUnit::Monetary) => monetary,
                    Some(MeasureUnit::Typed { unit_type: wanted, .. }) => match unit_type.as_deref() {
                        Some(t) => t == wanted || (!quantity && t == "USERDEFINED"),
                        None => !quantity && !monetary,
                    },
                    // A ratio, count or context-dependent measure may carry a
                    // unit (a percent, a context-dependent unit).
                    Some(MeasureUnit::Dimensionless) | None => !monetary,
                };
                if !fits {
                    let shown = unit_type.unwrap_or(unit_class);
                    return Err(format!("{what}: a {shown} unit does not measure an {measure_type}"));
                }
                units.push(Some(target));
            }
            out.push(units);
        }
        Ok(out)
    }
}

/// The unit record id of every value, building new SI units once per plan.
pub(super) fn build_units(emit: &mut Emit, shared: &mut Shared, units: &CheckedUnits) -> Result<Vec<Vec<Option<u32>>>, String> {
    let mut out = Vec::with_capacity(units.len());
    for set in units {
        let mut ids = Vec::with_capacity(set.len());
        for unit in set {
            ids.push(match unit {
                None => None,
                Some(Target::Existing(id)) => Some(*id),
                Some(Target::New(si)) => Some(shared.get_or(SharedKey::Si(si.clone()), || {
                    let (prefix, name, unit_type) = si;
                    new_record(
                        emit,
                        "IFCSIUNIT",
                        &[
                            ("Dimensions", "*".into()),
                            ("UnitType", format!(".{unit_type}.")),
                            ("Prefix", prefix.as_ref().map_or_else(|| "$".into(), |p| format!(".{p}."))),
                            ("Name", format!(".{name}.")),
                        ],
                    )
                })?),
            });
        }
        out.push(ids);
    }
    Ok(out)
}

/// The `IfcUnitEnum` an UPPERCASE `IfcSIUnitName` measures, or `None` when
/// `name` is not one.
fn si_unit_type(name: &str) -> Option<&'static str> {
    Some(match name {
        "METRE" => "LENGTHUNIT",
        "SQUARE_METRE" => "AREAUNIT",
        "CUBIC_METRE" => "VOLUMEUNIT",
        "GRAM" => "MASSUNIT",
        "SECOND" => "TIMEUNIT",
        "AMPERE" => "ELECTRICCURRENTUNIT",
        "KELVIN" | "DEGREE_CELSIUS" => "THERMODYNAMICTEMPERATUREUNIT",
        "MOLE" => "AMOUNTOFSUBSTANCEUNIT",
        "CANDELA" => "LUMINOUSINTENSITYUNIT",
        "RADIAN" => "PLANEANGLEUNIT",
        "STERADIAN" => "SOLIDANGLEUNIT",
        "HERTZ" => "FREQUENCYUNIT",
        "NEWTON" => "FORCEUNIT",
        "PASCAL" => "PRESSUREUNIT",
        "JOULE" => "ENERGYUNIT",
        "WATT" => "POWERUNIT",
        "COULOMB" => "ELECTRICCHARGEUNIT",
        "VOLT" => "ELECTRICVOLTAGEUNIT",
        "FARAD" => "ELECTRICCAPACITANCEUNIT",
        "OHM" => "ELECTRICRESISTANCEUNIT",
        "SIEMENS" => "ELECTRICCONDUCTANCEUNIT",
        "WEBER" => "MAGNETICFLUXUNIT",
        "TESLA" => "MAGNETICFLUXDENSITYUNIT",
        "HENRY" => "INDUCTANCEUNIT",
        "LUMEN" => "LUMINOUSFLUXUNIT",
        "LUX" => "ILLUMINANCEUNIT",
        "BECQUEREL" => "RADIOACTIVITYUNIT",
        "GRAY" => "ABSORBEDDOSEUNIT",
        "SIEVERT" => "DOSEEQUIVALENTUNIT",
        _ => return None,
    })
}
