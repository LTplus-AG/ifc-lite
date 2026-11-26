// SPDX-License-Identifier: MPL-2.0
//! Remove type links invalidated by a retype, leaving source mismatches alone.

use ifc_lite_core::SchemaVersion;

use super::{bare_ref, framed, is_list, list_items, read_slots, rebuild};
use crate::step_log::pass::Pass;

/// Compatibility as defined by the nearest applicable type-designating class.
/// IFC2X3 uses styles for doors and windows where IFC4 uses types.
fn compatible(schema: SchemaVersion, occurrence: &str, assigned: &str) -> Option<bool> {
    let assigned = schema.entity_info(assigned)?;
    let mut occurrence = schema.entity_info(occurrence)?;
    loop {
        let expected = match (schema, occurrence.name) {
            (SchemaVersion::Ifc2x3, "IFCDOOR") => "IFCDOORSTYLE".to_owned(),
            (SchemaVersion::Ifc2x3, "IFCWINDOW") => "IFCWINDOWSTYLE".to_owned(),
            _ => format!("{}TYPE", occurrence.name),
        };
        if schema.is_subtype_of(&expected, "IFCTYPEOBJECT") {
            return Some(schema.is_subtype_of(assigned.name, &expected));
        }
        let Some(parent) = occurrence.parent else { return Some(false) };
        occurrence = schema.entity_info(parent)?;
    }
}

pub(super) fn after_retypes(pass: &Pass<'_, '_>, line: &str, id: u32) -> Option<(Option<String>, String)> {
    let schema = SchemaVersion::from_file_schema(pass.schema)?;
    let (_, mut args) = read_slots(line)?;
    let assigned = bare_ref(args.get(5)?)?;
    let (lead, objects, trail) = framed(args.get(4)?);
    if !is_list(objects) {
        return None;
    }
    let original_type = pass.record_type(assigned)?;
    let effective_type = pass.type_of(assigned)?;
    let mut removed = Vec::new();
    let mut retained = Vec::new();
    for item in list_items(&objects[1..objects.len() - 1]) {
        let invalidated = bare_ref(&item).filter(|member|
            pass.overlay.retypes.contains_key(member) || original_type != effective_type
        ).filter(|&member| {
            let Some(original) = pass.record_type(member) else { return false };
            let Some(effective) = pass.type_of(member) else { return false };
            compatible(schema, &original, &original_type) == Some(true)
                && compatible(schema, &effective, &effective_type) == Some(false)
        });
        match invalidated {
            Some(member) => removed.push(format!("#{member}")),
            None => retained.push(item),
        }
    }
    if removed.is_empty() {
        return None;
    }
    let summary = format!(
        "Relationship #{id} (IFCRELDEFINESBYTYPE) lost its type assignment to #{assigned} for {} after retyping.",
        removed.join(", ")
    );
    if retained.is_empty() {
        return Some((None, format!("{summary} The empty relationship was withheld.")));
    }
    args[4] = format!("{lead}({}){trail}", retained.join(","));
    Some((Some(rebuild(line, &args)), summary))
}
