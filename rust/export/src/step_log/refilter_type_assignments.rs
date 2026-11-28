// SPDX-License-Identifier: MPL-2.0
//! Remove type links invalidated by a retype, leaving source mismatches alone.

use ifc_lite_core::{slot::IfcRelDefinesByType, SchemaVersion};

use super::{bare_ref, read_slots, rebuild};
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

/// A relationship may precede either endpoint. Use the writer's retype result
/// and cache it for other assignments that share the same endpoint.
fn emitted_type(pass: &mut Pass<'_, '_>, id: u32, original: &str) -> Option<String> {
    let requested = pass.type_of(id)?;
    if requested == original || pass.is_overlay_created(id) {
        return Some(requested);
    }
    let delivered = *pass.assignment_retype_delivered.entry(id).or_insert_with(|| {
        pass.src.line(id).is_some_and(|line|
            super::super::retype::retype_line(&line, original, &requested, None, pass.schema) != line)
    });
    Some(if delivered { requested } else { original.to_owned() })
}

pub(super) fn after_retypes(pass: &mut Pass<'_, '_>, line: &str, id: u32) -> Option<(Option<String>, String)> {
    let schema = SchemaVersion::from_file_schema(pass.schema)?;
    let (_, mut args) = read_slots(line)?;
    let assigned = bare_ref(args.get(IfcRelDefinesByType::RELATING_TYPE.index())?)?;
    let related_objects = IfcRelDefinesByType::RELATED_OBJECTS.index();
    let raw = args.get(related_objects)?;
    let open = ifc_lite_core::parser::skip_step_trivia(raw.as_bytes(), 0)?;
    if raw.as_bytes().get(open) != Some(&b'(') {
        return None;
    }
    // Frame the aggregate as a record so punctuation in comments stays trivia.
    const MARKER: &str = "#0=IFCLIST";
    let envelope = format!("{MARKER}{raw};");
    let frame = crate::step_record_frame::record_frame(&envelope)?;
    let close = frame.close - MARKER.len();
    let original_type = pass.record_type(assigned)?;
    let effective_type = emitted_type(pass, assigned, &original_type)?;
    let mut removed = Vec::new();
    let mut retained = Vec::new();
    for item in crate::step_slot::slots_of(&raw[open + 1..close])? {
        let invalidated = bare_ref(item).filter(|member|
            pass.overlay.retypes.contains_key(member) || original_type != effective_type
        ).filter(|&member| {
            let Some(original) = pass.record_type(member) else { return false };
            let Some(effective) = emitted_type(pass, member, &original) else { return false };
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
        pass.omitted_type_assignments.insert(id);
        return Some((None, format!("{summary} The empty relationship was withheld.")));
    }
    args[related_objects] = format!("{}{}{}", &raw[..=open], retained.join(","), &raw[close..]);
    Some((Some(rebuild(line, &args)), summary))
}
