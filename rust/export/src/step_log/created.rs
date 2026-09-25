// SPDX-License-Identifier: MPL-2.0
//! The entities the session created (`step-overlay-entities.ts`,
//! `step-overlay-attribute-overrides.ts`): each payload serialized slot by
//! slot, re-laid-out when retyped, with the session's named and positional
//! edits (and a repointed `HasPropertySets`) applied on top.

use serde_json::Value;

use super::attrs::{attr_names, named_attribute};
use super::lines::split_args;
use super::pass::Pass;
use super::refilter::{filter_created_line, Filtered};
use super::retype::retype_tokens;
use super::values::{attribute_slot, positional_override, Unwritable};

/// `applyOverlayEntityOverrides`.
fn overrides(
    pass: &mut Pass<'_, '_>,
    id: u32,
    args_text: &str,
    upper: &str,
    positionals: &[(usize, Value)],
) -> Result<String, Unwritable> {
    let mut args = split_args(args_text)
        .ok_or_else(|| Unwritable("Cannot apply an overlay override to an invalid STEP argument list.".to_string()))?;
    let names = attr_names(upper, "");
    let named: Vec<(usize, String)> = pass
        .attribute_edits(id)
        .unwrap_or(&[])
        .iter()
        .filter_map(|(n, v)| names.iter().position(|m| m == n).map(|i| (i, v.clone())))
        .collect();
    let pad = named.iter().any(|(i, _)| *i >= args.len())
        || positionals.iter().any(|(i, _)| *i >= args.len() && *i < names.len());
    if pad {
        while args.len() < names.len() {
            args.push("$".to_string());
        }
    }
    for (index, value) in named {
        match named_attribute(upper, index, &value, &args[index], pass.schema) {
            Some(s) => args[index] = s,
            None => pass.warnings.push(format!(
                "entity #{id}: attribute {} not written - {} is not a number and the slot is REAL-typed",
                names.get(index).copied().unwrap_or(""),
                Value::String(value)
            )),
        }
    }
    for (index, value) in positionals {
        if *index < args.len() {
            args[*index] = positional_override(upper, *index, value, &args[*index], pass.schema)?;
        }
    }
    Ok(args.join(","))
}

/// `writeOverlayCreatedEntities`, into `pass.created_lines`.
pub(crate) fn write_created(pass: &mut Pass<'_, '_>) -> Result<(), Unwritable> {
    let entities = pass.overlay.new_entities.clone();
    for entity in entities {
        let id = entity.express_id;
        if pass.skip.contains(&id) {
            continue;
        }
        let retype = pass.overlay.retypes.get(&id).cloned();
        let effective = retype.as_ref().map_or(entity.entity_type.clone(), |(t, _)| t.clone());
        let upper = effective.to_uppercase();
        let record_upper = entity.entity_type.to_uppercase();
        let mut args_text = match &retype {
            Some((new_type, predefined)) => {
                let tokens: Result<Vec<String>, Unwritable> = entity
                    .attributes
                    .iter()
                    .enumerate()
                    .map(|(i, v)| attribute_slot(&record_upper, i, v, pass.schema))
                    .collect();
                let (tokens, _) = retype_tokens(&tokens?, &entity.entity_type, new_type, predefined.as_deref(), pass.schema);
                tokens.join(",")
            }
            None => {
                let tokens: Result<Vec<String>, Unwritable> = entity
                    .attributes
                    .iter()
                    .enumerate()
                    .map(|(i, v)| attribute_slot(&record_upper, i, v, pass.schema))
                    .collect();
                tokens?.join(",")
            }
        };
        let mut positionals = pass.overlay.positionals(id).to_vec();
        if let Some(value) = pass.overlay_type_owned.iter().find(|(e, _)| *e == id).map(|(_, v)| v.clone()) {
            match positionals.iter_mut().find(|(i, _)| *i == 5) {
                Some(slot) => slot.1 = value,
                None => positionals.push((5, value)),
            }
        }
        if pass.attribute_edits(id).is_some_and(|e| !e.is_empty()) || !positionals.is_empty() {
            args_text = overrides(pass, id, &args_text, &upper, &positionals)?;
        }
        let line = format!("#{id}={upper}({args_text});");
        let filtered = {
            let excluded = |r: u32| pass.is_omitted(r);
            filter_created_line(&line, id, &upper, &excluded)
        };
        let line = match filtered {
            Filtered::Keep => line,
            Filtered::Rewrite(l) => l,
            Filtered::Withhold(w) => {
                pass.warnings.push(w);
                continue;
            }
        };
        pass.created_lines.push((id, line));
        pass.new_entity_count += 1;
    }
    Ok(())
}
