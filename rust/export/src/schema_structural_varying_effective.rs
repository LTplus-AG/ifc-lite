// SPDX-License-Identifier: MPL-2.0
//! A filtered or edited export can only convert actions using what it actually emits.

use std::collections::{HashMap, HashSet};

use ifc_lite_core::{parser::parse_ref, EntityScanner};

use crate::schema_convert::holds_value;
use crate::schema_structural_axes::list_items;
use crate::schema_structural_carriers::StructuralCarriers;
use crate::schema_structural_varying::StructuralVarying;
use crate::step_ids::IdAllocator;
use crate::step_record_frame::record_frame;
use crate::step_slot::split_top_level_args;

const LOSS: &str = "The retained varying structural action has no complete load configuration; its varying locations and subsequent loads were omitted (#11037).";
const MISSING_LOAD: &str = "The retained varying structural action has no usable AppliedLoad; the required IFC4 slot was left unset (#11037).";

pub(super) fn contains_varying(content: &[u8]) -> bool {
    let mut scan = EntityScanner::new(content);
    std::iter::from_fn(|| scan.next_entity()).any(|(_, ty, _, _)| StructuralVarying::target(ty).is_some())
}

pub(super) struct EffectiveResult {
    pub(super) body: String,
    pub(super) added: usize,
    pub(super) dropped: usize,
    pub(super) warnings: Vec<String>,
}

struct Record<'a> {
    ty: &'a str,
    start: usize,
    end: usize,
}

pub(super) fn finish(text: &str) -> Option<EffectiveResult> {
    let (records, mut actions) = index(text);
    if actions.is_empty() {
        return None;
    }
    actions.sort_unstable_by_key(|id| records[id].start);
    let max = records.keys().copied().max().unwrap_or_default();
    let mut ids = IdAllocator::after(max);
    let incomplete_aspects = incomplete_aspects(text, &records);
    let mut plan = StructuralVarying::scan_ifc2x3(text.as_bytes(), |id, _| !incomplete_aspects.contains(&id));
    let mut carriers = StructuralCarriers::scan_ifc2x3(text.as_bytes(), |_, _| true);
    for &action in &actions {
        if let Some(id) = carriers.needs_id(action, true).then(|| ids.allocate()).flatten() {
            carriers.assign(action, id);
        }
        if let Some(id) = plan.plans(action).then(|| ids.allocate()).flatten() {
            plan.assign(action, id);
        }
    }
    let mut result = EffectiveResult { body: String::with_capacity(text.len()), added: 0, dropped: 0, warnings: Vec::new() };
    let mut copied = 0;
    for id in actions {
        let record = &records[&id];
        let line = &text[record.start..record.end];
        let Some(frame) = record_frame(line) else { continue };
        let Some(mut args) = split_top_level_args(frame.args(line)) else { continue };
        args.resize(14, "$".to_owned());
        for slot in [1, 5, 6] {
            if reference(&args[slot], &records).is_none() {
                args[slot] = "$".to_owned();
            }
        }
        result.body.push_str(&text[copied..record.start]);
        copied = record.end;
        let ty = record.ty.to_ascii_uppercase();
        let cause = carriers.cause(id);
        if let Some(message) = cause {
            result.warnings.push(message.to_owned());
            carriers.write(id);
        }
        let body = if let Some((body, warnings, cause_dropped)) = plan.rewrite(id, &ty, &args, cause.is_some()) {
            result.dropped += usize::from(cause_dropped);
            result.warnings.extend(warnings);
            body
        } else {
            fallback(&ty, &mut args, &records, cause.is_some(), &mut result)
        };
        result.body.push_str(&format!("#{id}={body};"));
    }
    result.body.push_str(&text[copied..]);
    for added in plan.added().into_iter().chain(carriers.added()) {
        result.body.push_str(&added);
        result.body.push('\n');
        result.added += 1;
    }
    Some(result)
}

fn index(text: &str) -> (HashMap<u32, Record<'_>>, Vec<u32>) {
    let mut records = HashMap::new();
    let mut actions = Vec::new();
    let mut scan = EntityScanner::new(text);
    while let Some((id, ty, start, end)) = scan.next_entity() {
        if StructuralVarying::target(ty).is_some() {
            actions.push(id);
        }
        records.insert(id, Record { ty, start, end });
    }
    (records, actions)
}

fn reference<'r, 'a>(value: &str, records: &'r HashMap<u32, Record<'a>>) -> Option<&'r Record<'a>> {
    records.get(&parse_ref(value.as_bytes())?)
}

fn incomplete_aspects(text: &str, records: &HashMap<u32, Record<'_>>) -> HashSet<u32> {
    records.iter().filter_map(|(&id, rec)| {
        if !rec.ty.eq_ignore_ascii_case("IFCSHAPEASPECT") {
            return None;
        }
        let retain = crate::schema_structural_varying::record(text.as_bytes(), rec.start, rec.end)
            .is_some_and(|args| args.get(4).and_then(|shape| reference(shape, records)).is_some()
                && args.first().and_then(|slot| list_items(slot)).is_some_and(|members|
                    members.iter().all(|member| reference(member, records).is_some())));
        (!retain).then_some(id)
    }).collect()
}

fn fallback(ty: &str, args: &mut [String], records: &HashMap<u32, Record<'_>>, cause_carried: bool, result: &mut EffectiveResult) -> String {
    let actual = reference(&args[7], records);
    let target = StructuralVarying::target(ty).expect("indexed only varying actions");
    let load_type = actual.map(|r| r.ty.to_ascii_uppercase());
    if !load_type.is_some_and(|ty| ifc_lite_core::is_subtype_of_for_schema("IFC4", &ty, "IFCSTRUCTURALLOAD")) {
        result.dropped += usize::from(holds_value(&args[7]));
        args[7] = "$".to_owned();
        result.warnings.push(MISSING_LOAD.to_owned());
    }
    if !cause_carried && holds_value(&args[10]) {
        result.warnings.push(format!("{ty}.CausedBy has no slot in IFC4; its value is omitted (#11037)."));
        result.dropped += 1;
    }
    result.dropped += [12, 13].into_iter().filter(|&at| holds_value(&args[at])).count();
    result.warnings.push(LOSS.to_owned());
    format!("{target}({},{},.CONST.)", args[..10].join(","), args[11])
}
