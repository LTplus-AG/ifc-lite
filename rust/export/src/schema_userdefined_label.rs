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

use crate::schema_convert::schema_attribute_names;
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
    // The head names the type; most records stop here.
    let Some(head) = crate::step_record_frame::record_head(&converted) else { return converted };
    let ty = head.type_name(&converted);
    let layout_type = if up && cto == "IFC4X3" && ty.eq_ignore_ascii_case("IFCDISTRIBUTIONBOARD") {
        "IFCELECTRICDISTRIBUTIONBOARD"
    } else {
        ty
    };
    let Some(&(ifc2x3, _, enum_2x3, label_2x3)) = LABEL_CARRIES.iter().find(|c| layout_type.eq_ignore_ascii_case(if up { c.1 } else { c.0 })) else { return converted };
    let Some(frame) = crate::step_record_frame::record_frame(&converted) else { return converted };
    let Some(mut out) = split_top_level_args(frame.args(&converted)) else { return converted };
    let index = |schema: &str, ty: &str, name: &str| schema_attribute_names(schema, ty)?.iter().position(|n| *n == name);
    if up {
        let (Some(ot), Some(e), Some(l)) = (index(cto, ty, "ObjectType"), index(cfrom, ifc2x3, enum_2x3), index(cfrom, ifc2x3, label_2x3)) else { return converted };
        // `convert_record` also accepts a record without its ';'.
        let read = |line: &str| crate::step_record_frame::record_frame(line).and_then(|f| split_top_level_args(f.args(line)));
        let Some(src) = read(source).or_else(|| read(&format!("{source};"))) else { return converted };
        let (Some(kind), Some(label)) = (src.get(e), src.get(l)) else { return converted };
        if !is_userdefined(kind) || is_unset(label) || out.get(ot).is_none_or(|v| !is_unset(v)) { return converted; }
        out[ot] = label.clone();
        // The trim or map before this counted the label as dropped.
        if let Some(dropped) = dropped { *dropped = dropped.saturating_sub(1); }
    } else {
        let (Some(ot), Some(e), Some(l)) = (index(cto, ifc2x3, "ObjectType"), index(cto, ifc2x3, enum_2x3), index(cto, ifc2x3, label_2x3)) else { return converted };
        let (Some(kind), Some(label), Some(object_type)) = (out.get(e), out.get(l), out.get(ot)) else { return converted };
        if !is_userdefined(kind) || !is_unset(label) || is_unset(object_type) { return converted; }
        out[l] = object_type.clone();
    }
    frame.with_args(&converted, &out.join(","))
}

/// True when `slot` is `token` (any case) with only whitespace and comments around it.
pub(crate) fn is_token(slot: &str, token: &str) -> bool {
    let bytes = slot.as_bytes();
    let Some(start) = ifc_lite_core::parser::skip_step_trivia(bytes, 0) else { return false };
    slot.get(start..start + token.len()).is_some_and(|t| t.eq_ignore_ascii_case(token))
        && ifc_lite_core::parser::skip_step_trivia(bytes, start + token.len()) == Some(bytes.len())
}

fn is_userdefined(slot: &str) -> bool {
    is_token(slot, ".USERDEFINED.")
}

/// No value: `$`, `*` or nothing, comments aside.
pub(crate) fn is_unset(slot: &str) -> bool {
    is_token(slot, "$") || is_token(slot, "*") || ifc_lite_core::parser::skip_step_trivia(slot.as_bytes(), 0) == Some(slot.len())
}

#[cfg(test)]
#[path = "schema_userdefined_label_tests.rs"]
mod tests;
