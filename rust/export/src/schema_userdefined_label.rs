// SPDX-License-Identifier: MPL-2.0
//! The label of a `.USERDEFINED.` type across IFC2X3 and IFC4 (#10824).
//!
//! IFC2X3 kept it in a type-specific attribute (`UserDefinedControlType`,
//! `UserDefinedProcedureType`, `UserDefinedFunction`); IFC4 keeps it in
//! `ObjectType` and has no such attribute, so an upgrade dropped it and wrote
//! `.USERDEFINED.` with `ObjectType` unset, which IFC4's
//! `CorrectPredefinedType` rejects. An upgrade now writes the IFC2X3 label into
//! an unset `ObjectType`, and a downgrade writes `ObjectType` into the unset
//! IFC2X3 label, which IFC2X3's own WHERE rule requires. A set `ObjectType` is
//! kept, and the IFC2X3 label is then dropped (and counted, as before).
//!
//! Twin of `packages/export/src/schema-converter-userdefined-label.ts`.

use crate::schema_convert::{holds_value, schema_attribute_names};
use crate::step_slot::split_top_level_args;

/// One type: `(IFC2X3 type, IFC4 type, IFC2X3 enum, IFC2X3 label)`; the IFC4
/// label is `ObjectType`.
pub(crate) const LABEL_CARRIES: &[(&str, &str, &str, &str)] = &[
    ("IFCPROCEDURE", "IFCPROCEDURE", "ProcedureType", "UserDefinedProcedureType"),
    ("IFCWORKPLAN", "IFCWORKPLAN", "WorkControlType", "UserDefinedControlType"),
    ("IFCWORKSCHEDULE", "IFCWORKSCHEDULE", "WorkControlType", "UserDefinedControlType"),
    ("IFCELECTRICDISTRIBUTIONPOINT", "IFCELECTRICDISTRIBUTIONBOARD", "DistributionPointFunction", "UserDefinedFunction"),
];

/// `converted`, written from `source` between `cfrom` and `cto`, with the
/// label carried; a carried label is taken off `dropped`, which counted it.
pub(crate) fn carry(source: &str, converted: String, cfrom: &str, cto: &str, dropped: Option<&mut usize>) -> String {
    let ifc4_like = |s: &str| matches!(s, "IFC4" | "IFC4X3");
    let up = match (cfrom, cto) {
        ("IFC2X3", to) if ifc4_like(to) => true,
        (from, "IFC2X3") if ifc4_like(from) => false,
        _ => return converted,
    };
    let Some(frame) = crate::step_record_frame::record_frame(&converted) else { return converted };
    let ty = frame.head.type_name(&converted).to_ascii_uppercase();
    let Some(&(ifc2x3, ifc4, enum_2x3, label_2x3)) = LABEL_CARRIES.iter().find(|c| ty == if up { c.1 } else { c.0 }) else { return converted };
    let index = |schema: &str, ty: &str, name: &str| schema_attribute_names(schema, ty)?.iter().position(|n| *n == name);
    let Some(mut out) = split_top_level_args(frame.args(&converted)) else { return converted };
    let slot = |out: &[String], i: Option<usize>| i.and_then(|i| out.get(i).cloned());
    if up {
        let (Some(ot), Some(e), Some(l)) = (index(cto, ifc4, "ObjectType"), index(cfrom, ifc2x3, enum_2x3), index(cfrom, ifc2x3, label_2x3)) else { return converted };
        let Some(src) = crate::step_record_frame::record_frame(source).and_then(|f| split_top_level_args(f.args(source))) else { return converted };
        let (Some(kind), Some(label)) = (slot(&src, Some(e)), slot(&src, Some(l))) else { return converted };
        if !is_userdefined(&kind) || !holds_value(&label) || out.get(ot).is_none_or(|v| holds_value(v)) { return converted; }
        out[ot] = label;
        if let Some(dropped) = dropped { *dropped = dropped.saturating_sub(1); }
    } else {
        let (Some(ot), Some(e), Some(l)) = (index(cto, ifc2x3, "ObjectType"), index(cto, ifc2x3, enum_2x3), index(cto, ifc2x3, label_2x3)) else { return converted };
        let (Some(kind), Some(label), Some(object_type)) = (slot(&out, Some(e)), slot(&out, Some(l)), slot(&out, Some(ot))) else { return converted };
        if !is_userdefined(&kind) || holds_value(&label) || !holds_value(&object_type) { return converted; }
        out[l] = object_type;
    }
    frame.with_args(&converted, &out.join(","))
}

/// True when `slot` is `.USERDEFINED.` (any case) with only whitespace and
/// comments around it.
fn is_userdefined(slot: &str) -> bool {
    let bytes = slot.as_bytes();
    let token = ".USERDEFINED.";
    let Some(start) = ifc_lite_core::parser::skip_step_trivia(bytes, 0) else { return false };
    slot.get(start..start + token.len()).is_some_and(|t| t.eq_ignore_ascii_case(token))
        && ifc_lite_core::parser::skip_step_trivia(bytes, start + token.len()) == Some(bytes.len())
}

#[cfg(test)]
#[path = "schema_userdefined_label_tests.rs"]
mod tests;
