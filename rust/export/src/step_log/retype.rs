// SPDX-License-Identifier: MPL-2.0
//! `UPDATE_ENTITY_TYPE` on a record (`retype.ts`): the class keyword swapped,
//! attribute values re-laid-out BY NAME against the target class's list, and
//! the requested `PredefinedType` validated against the target's enum domain
//! (an unknown one becomes `.USERDEFINED.` plus `ObjectType` / `ElementType`,
//! as IfcOpenShell's `reassign_class` does).

use crate::generated::step_log_tables::{NAME_LISTS, RETYPE_ROWS};
use crate::step_text::escape;

use super::lines::split_args;

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

/// `retypeStepLine`.
pub(crate) fn retype_line(text: &str, source_type: &str, new_type: &str, predefined: Option<&str>, schema: &str) -> String {
    let (Some(eq), Some(open), Some(close)) = (text.find('='), text.find('('), text.rfind(");")) else {
        return text.to_string();
    };
    if open < eq || close < open {
        return text.to_string();
    }
    let upper = new_type.to_uppercase();
    let Some(tokens) = split_args(&text[open + 1..close]) else { return text.to_string() };
    let (tokens, resolved) = retype_tokens(&tokens, source_type, new_type, predefined, schema);
    if !resolved {
        return format!("{}{upper}{}", &text[..=eq], &text[open..]);
    }
    format!("{}{upper}({}{}", &text[..=eq], tokens.join(","), &text[close..])
}
