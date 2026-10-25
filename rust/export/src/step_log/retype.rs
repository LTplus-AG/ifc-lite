// SPDX-License-Identifier: MPL-2.0
//! `UPDATE_ENTITY_TYPE` on a record (`retype.ts`): the class keyword swapped,
//! attribute values re-laid-out BY NAME against the target class's list, and
//! the requested `PredefinedType` validated against the target's enum domain
//! (an unknown one becomes `.USERDEFINED.` plus `ObjectType` / `ElementType`,
//! as IfcOpenShell's `reassign_class` does).

use crate::generated::step_log_tables::{NAME_LISTS, RETYPE_ROWS};
use crate::step_text::escape;

use super::lines::split_args;
use crate::step_record_frame::record_frame;

struct Info {
    attributes: &'static [&'static str],
    predefined: &'static [&'static str],
}

fn in_schema(schema: &str, upper: &str) -> Option<Info> {
    RETYPE_ROWS
        .binary_search_by(|r| (r.0, r.1).cmp(&(schema, upper)))
        .ok()
        .map(|i| Info { attributes: NAME_LISTS[usize::from(RETYPE_ROWS[i].2)], predefined: NAME_LISTS[usize::from(RETYPE_ROWS[i].3)] })
}

/// The `PredefinedType` members `class` (any case) declares in the family of
/// the `FILE_SCHEMA` label `schema` (`IFC4X3_ADD2` reads IFC4X3's table),
/// without falling back to another schema's table. `None` when the table has
/// no row for it; empty when the class has no such enum.
pub(crate) fn predefined_type_members(schema: &str, class: &str) -> Option<&'static [&'static str]> {
    use ifc_lite_core::SchemaVersion;
    let family = match SchemaVersion::from_file_schema(schema)? {
        SchemaVersion::Ifc2x3 => "IFC2X3",
        SchemaVersion::Ifc4 => "IFC4",
        SchemaVersion::Ifc4x3 => "IFC4X3",
        _ => return None,
    };
    in_schema(family, &class.to_uppercase()).map(|info| info.predefined)
}

/// The table family a `FILE_SCHEMA` label reads: IFC4X1 and IFC4X2 read
/// IFC4's, IFC5 reads IFC4X3's; `None` for a schema this engine has no table
/// for.
pub(crate) fn schema_family(schema: &str) -> Option<&'static str> {
    use ifc_lite_core::SchemaVersion;
    if schema == "IFC5" {
        return Some("IFC4X3");
    }
    match SchemaVersion::from_file_schema(schema)? {
        SchemaVersion::Ifc2x3 => Some("IFC2X3"),
        SchemaVersion::Ifc4 | SchemaVersion::Ifc4x1 | SchemaVersion::Ifc4x2 => Some("IFC4"),
        SchemaVersion::Ifc4x3 => Some("IFC4X3"),
        _ => None,
    }
}

/// Whether the family of the `FILE_SCHEMA` label `schema` declares `name`
/// (any case), an entity or a defined type. IFC4X1 and IFC4X2 have no table
/// of their own and read IFC4's; IFC5 reads IFC4X3's, as `lookup` does; anything else unknown is refused.
pub(crate) fn schema_declares(schema: &str, name: &str) -> bool {
    schema_family(schema).is_some_and(|family| in_schema(family, &name.to_uppercase()).is_some())
}

/// `lookupEntityInfo`: the source schema's table (IFC5 reads IFC4X3's), then IFC4's.
fn lookup(schema: &str, name: &str) -> Option<Info> {
    let upper = name.to_uppercase();
    let table = if schema == "IFC5" { "IFC4X3" } else { schema };
    in_schema(table, &upper).or_else(|| in_schema("IFC4", &upper))
}

fn enum_value(token: &str) -> Option<&str> {
    let t = token.trim();
    (t.len() >= 2 && t.starts_with('.') && t.ends_with('.')).then(|| &t[1..t.len() - 1])
}

/// `retypeArgTokens`: `(tokens, resolved)`.
pub(crate) fn retype_tokens(
    tokens: &[String],
    source_type: &str,
    new_type: &str,
    predefined: Option<&str>,
    schema: &str,
) -> (Vec<String>, bool) {
    let (Some(source), Some(target)) = (lookup(schema, source_type), lookup(schema, new_type)) else {
        return (tokens.to_vec(), false);
    };
    let mut by_name: Vec<(&str, &String)> = Vec::new();
    for (i, token) in tokens.iter().enumerate().take(source.attributes.len()) {
        let name = source.attributes[i];
        match by_name.iter_mut().find(|(n, _)| *n == name) {
            Some(entry) => entry.1 = token,
            None => by_name.push((name, token)),
        }
    }
    let get = |name: &str| by_name.iter().find(|(n, _)| *n == name).map(|(_, t)| (*t).clone());
    let mut out: Vec<String> = target.attributes.iter().map(|n| get(n).unwrap_or_else(|| "$".to_string())).collect();
    if let Some(slot) = target.attributes.iter().position(|n| *n == "PredefinedType") {
        match predefined.filter(|p| !p.is_empty()) {
            Some(requested) => {
                let symbol = enum_value(requested).unwrap_or(requested).trim().to_uppercase();
                if target.predefined.contains(&symbol.as_str()) {
                    out[slot] = format!(".{symbol}.");
                } else {
                    out[slot] = ".USERDEFINED.".to_string();
                    let label = target
                        .attributes
                        .iter()
                        .position(|n| *n == "ObjectType")
                        .or_else(|| target.attributes.iter().position(|n| *n == "ElementType"));
                    if let Some(label) = label {
                        out[label] = format!("'{}'", escape(requested));
                    }
                }
            }
            None => {
                if let Some(carried) = enum_value(&out[slot]) {
                    if !target.predefined.contains(&carried) {
                        out[slot] = "$".to_string();
                    }
                }
            }
        }
    }
    (out, true)
}

/// `retypeStepLine`: the keyword swapped and, when both classes are known,
/// the argument list re-laid-out; every other byte of the record is kept.
pub(crate) fn retype_line(text: &str, source_type: &str, new_type: &str, predefined: Option<&str>, schema: &str) -> String {
    let Some(frame) = record_frame(text) else { return text.to_string() };
    let head = frame.head;
    let upper = new_type.to_uppercase();
    let Some(tokens) = split_args(frame.args(text)) else { return text.to_string() };
    let (tokens, resolved) = retype_tokens(&tokens, source_type, new_type, predefined, schema);
    let retyped = format!("{}{upper}{}", &text[..head.type_start], &text[head.type_end..]);
    if !resolved {
        return retyped;
    }
    // The keyword's length changed; the frame's offsets past it move with it.
    let shift = |at: usize| at + upper.len() - (head.type_end - head.type_start);
    format!("{}{}{}", &retyped[..=shift(head.open)], tokens.join(","), &retyped[shift(frame.close)..])
}
