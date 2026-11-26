// SPDX-License-Identifier: MPL-2.0
//! An IFC2X3 styled item references assignments instead of the styles directly.

use crate::schema_ifc2x3_records::{Rec, Records};
use crate::schema_structural_axes::list_items;
use crate::schema_structural_links::slot_ref;
use crate::step_record_frame::record_frame;
use crate::step_slot::slots_of;

const ASSIGNMENT: &str = "IFCPRESENTATIONSTYLEASSIGNMENT";

pub(super) fn wrap_direct_styles(records: &Records<'_>, rec: &Rec<'_>, id: u32) -> Option<(String, String)> {
    let frame = record_frame(rec.text)?;
    let parts = slots_of(frame.args(rec.text))?;
    let [item, members, name] = parts.as_slice() else { return None };
    let members = list_items(members)?;
    let mut styles = Vec::new();
    let mut assignments = Vec::new();
    for member in &members {
        let style = records.get(slot_ref(member), None)?;
        if style.ty == ASSIGNMENT {
            assignments.push(member.as_str());
        } else if ifc_lite_core::is_subtype_of_for_schema("IFC2X3", &style.ty, "IFCPRESENTATIONSTYLE") {
            styles.push(member.as_str());
        } else {
            return None;
        }
    }
    if styles.is_empty() {
        return None;
    }
    let reference = format!("#{id}");
    assignments.push(&reference);
    Some((
        frame.with_args(rec.text, &format!("{item},({}),{name}", assignments.join(","))),
        format!("{reference}={ASSIGNMENT}(({}));", styles.join(",")),
    ))
}
