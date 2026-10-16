// SPDX-License-Identifier: MPL-2.0
//! `BaseSets`' `IfcComplexProperty` walk (#7675): every complex property a
//! property set lists, resolved once per file against the model's budget.
//! Split out of `base.rs` for the module-size rule; a child module, so it
//! reads `BaseSets`' fields directly.

use std::collections::HashMap;

use serde_json::Value;

use ifc_lite_core::limits::{
    complex_property_depth_marker, complex_property_listing_bytes, ComplexPropertyBudget, COMPLEX_PROPERTY_BUDGET_MARKER,
    MAX_COMPLEX_PROPERTY_DEPTH,
};

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
            // Walked once per complex property id; a repeat listing reuses the
            // value, charged what it keeps (`ComplexPropertyBudget::listing`).
            let mut memo = HashMap::new();
            // `of_type` holds each set id once, at its last record (keep-last,
            // as core indexes it), the record `entity` reads.
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
                    let value = budget.listing(
                        &mut memo,
                        *n as u32,
                        |budget| {
                            budget.start_property();
                            let (value, values) = self.complex_value(&pattrs, 0, budget);
                            let shown = value.as_str().unwrap_or("");
                            let bytes = complex_property_listing_bytes(shown, &values);
                            ((pvt::STRING, value, None), bytes)
                        },
                        budget_spent,
                    );
                    by_listing.insert((pid, index), value);
                }
            }
            by_listing
        })
    }

    /// `resolveComplexPropertyValue`: the display value, and the level's
    /// `values` list the TS and server walks keep (each part's display, then
    /// the budget marker when cut), which only the repeat-listing charge
    /// reads. Every bound, marker, charge and the check order are
    /// `ifc_lite_core::limits`' (#7675), shared with the server's walk and
    /// mirrored by the TypeScript one, so both exporters write the same value
    /// for the same file.
    fn complex_value(&self, attrs: &[JsVal], depth: usize, budget: &mut ComplexPropertyBudget) -> (Value, Vec<String>) {
        let usage = attrs.get(2).and_then(JsVal::as_str).unwrap_or("").to_string();
        let empty_usage = || if usage.is_empty() { Value::Null } else { Value::String(usage.clone()) };
        let Some(JsVal::Arr(members)) = attrs.get(3) else { return (empty_usage(), Vec::new()) };
        if members.is_empty() {
            return (empty_usage(), Vec::new());
        }
        if depth >= MAX_COMPLEX_PROPERTY_DEPTH {
            let marker = complex_property_depth_marker();
            let text = if usage.is_empty() { marker } else { format!("{usage} {marker}") };
            return (Value::String(text), Vec::new());
        }
        let mut parts = Vec::new();
        let mut values = Vec::new();
        let mut cut = false;
        for member in members {
            let JsVal::Num(n) = member else { continue };
            if !budget.admit_member() {
                cut = true;
                break;
            }
            let Some((mty, mattrs)) = self.src.entity(*n as u32) else { continue };
            let mname = mattrs.first().and_then(JsVal::as_str).unwrap_or("").to_string();
            let v = if mty == "IFCCOMPLEXPROPERTY" {
                self.complex_value(&mattrs, depth + 1, budget).0
            } else {
                self.property_value(&mty, &mattrs).1
            };
            let display = if v.is_null() { String::new() } else { super::super::jsval::json_to_js_string(&v) };
            if let Some(part) = budget.member_part(&mname, &display) {
                parts.push(part);
                values.push(display);
            }
        }
        let value = budget.level_value(&parts, cut).map_or_else(empty_usage, Value::String);
        if cut {
            values.push(COMPLEX_PROPERTY_BUDGET_MARKER.to_string());
        }
        (value, values)
    }
}

/// The value of a repeat listing `ComplexPropertyBudget::listing` refused,
/// and of a listing the file pass did not resolve (unreachable for a set
/// `psets_from_ids` reads, since the pass walks the same sets; spent rather
/// than walked with a budget of its own, which would reopen #7675).
pub(super) fn budget_spent() -> (u8, Value, Option<String>) {
    (pvt::STRING, Value::String(COMPLEX_PROPERTY_BUDGET_MARKER.to_string()), None)
}
