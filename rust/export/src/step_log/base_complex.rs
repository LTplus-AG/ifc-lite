// SPDX-License-Identifier: MPL-2.0
//! `BaseSets`' `IfcComplexProperty` walk (#7675): every complex property a
//! property set lists, resolved once per file against the model's budget.
//! Split out of `base.rs` for the module-size rule; a child module, so it
//! reads `BaseSets`' fields directly.

use std::collections::HashMap;

use serde_json::Value;

use ifc_lite_core::limits::{complex_property_depth_marker, ComplexPropertyBudget, MAX_COMPLEX_PROPERTY_DEPTH};

use super::{pvt, BaseSets, ComplexValues, JsVal};

impl BaseSets<'_, '_> {
    /// Every `IfcComplexProperty` a property set lists, resolved once for the
    /// file against ONE budget relative to its size, in file order of the sets
    /// and then `HasProperties` order: the policy of `ifc_lite_core::limits`'
    /// `complex_property_output_budget`, which the server's extraction and the
    /// browser's store share (#7675). Resolving per call instead let every
    /// entity sharing a set build the value again with a fresh budget. Built on
    /// the first complex property an export reads, so a file without one
    /// never pays for the pass.
    pub(super) fn complex_values(&self) -> &ComplexValues {
        self.complex.get_or_init(|| {
            let mut budget = ComplexPropertyBudget::for_input(self.src.content.len());
            let mut by_listing = HashMap::new();
            for &pid in self.src.of_type("IFCPROPERTYSET") {
                let Some((_, attrs)) = self.src.entity(pid) else { continue };
                let Some(JsVal::Arr(items)) = attrs.get(4) else { continue };
                for (index, item) in items.iter().enumerate() {
                    let JsVal::Num(n) = item else { continue };
                    // The record head names the type; only a complex
                    // property's record is decoded.
                    if self.src.type_of(*n as u32).as_deref() != Some("IFCCOMPLEXPROPERTY") {
                        continue;
                    }
                    let Some((_, pattrs)) = self.src.entity(*n as u32) else { continue };
                    // Listed under a Name (empty or not), as the server and TS
                    // passes resolve it.
                    if pattrs.first().and_then(JsVal::as_str).is_none() {
                        continue;
                    }
                    budget.start_property();
                    by_listing.insert((pid, index), self.complex_value(&pattrs, 0, &mut budget));
                }
            }
            by_listing
        })
    }

    /// `resolveComplexPropertyValue`: a display string only. Every bound,
    /// marker, charge and the check order are `ifc_lite_core::limits`'
    /// (#7675), shared with the server's walk and mirrored by the TypeScript
    /// one, so both exporters write the same value for the same file.
    fn complex_value(&self, attrs: &[JsVal], depth: usize, budget: &mut ComplexPropertyBudget) -> (u8, Value, Option<String>) {
        let usage = attrs.get(2).and_then(JsVal::as_str).unwrap_or("").to_string();
        let empty_usage = || if usage.is_empty() { Value::Null } else { Value::String(usage.clone()) };
        let Some(JsVal::Arr(members)) = attrs.get(3) else { return (pvt::STRING, empty_usage(), None) };
        if members.is_empty() {
            return (pvt::STRING, empty_usage(), None);
        }
        if depth >= MAX_COMPLEX_PROPERTY_DEPTH {
            let marker = complex_property_depth_marker();
            let text = if usage.is_empty() { marker } else { format!("{usage} {marker}") };
            return (pvt::STRING, Value::String(text), None);
        }
        let mut parts = Vec::new();
        let mut cut = false;
        for member in members {
            let JsVal::Num(n) = member else { continue };
            if !budget.admit_member() {
                cut = true;
                break;
            }
            let Some((mty, mattrs)) = self.src.entity(*n as u32) else { continue };
            let mname = mattrs.first().and_then(JsVal::as_str).unwrap_or("").to_string();
            let (_, v, _) = if mty == "IFCCOMPLEXPROPERTY" {
                self.complex_value(&mattrs, depth + 1, budget)
            } else {
                self.property_value(&mty, &mattrs)
            };
            let display = if v.is_null() { String::new() } else { super::super::jsval::json_to_js_string(&v) };
            if let Some(part) = budget.member_part(&mname, &display) {
                parts.push(part);
            }
        }
        let value = budget.level_value(&parts, cut).map_or_else(empty_usage, Value::String);
        (pvt::STRING, value, None)
    }
}

/// The value of a listing the file pass did not resolve. Unreachable for a
/// set `psets_from_ids` reads (the pass walks the same sets), and spent
/// rather than walked with a budget of its own, which would reopen #7675.
pub(super) fn budget_spent() -> (u8, Value, Option<String>) {
    (pvt::STRING, Value::String(ifc_lite_core::limits::COMPLEX_PROPERTY_BUDGET_MARKER.to_string()), None)
}
