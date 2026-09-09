// This Source Code Form is subject to the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Keep composite private plans compatible with sequential host allocation.
use std::collections::BTreeMap;
use super::*;

pub(super) fn compact(plan: &mut AppearancePlan) -> BTreeMap<u32,u32> {
    plan.created.sort_unstable_by_key(|entity|entity.express_id);
    let ids:BTreeMap<_,_>=plan.created.iter().enumerate()
        .map(|(index,entity)|(entity.express_id,plan.next_express_id+index as u32)).collect();
    // These are generated, already-budgeted plan values, not source reference
    // traversal. Iteration also avoids recursive allocation when rebinding arrays.
    let mut values=Vec::new();
    for entity in &mut plan.created {
        entity.express_id=ids[&entity.express_id];
        values.extend(entity.attributes.iter_mut());
    }
    for edit in &mut plan.edits { values.push(&mut edit.value); }
    while let Some(value)=values.pop() {
        match value {
            Value::String(text)=> {
                if let Some(id)=text.strip_prefix('#').and_then(|id|id.parse::<u32>().ok()).and_then(|id|ids.get(&id)) {
                    *text=format!("#{id}");
                }
            },
            Value::Array(items)=>values.extend(items.iter_mut()),
            _=>{},
        }
    }
    for item in &mut plan.items { if let Some(&id)=ids.get(&item.geometry_item_id) {item.geometry_item_id=id;} }
    for item in &mut plan.conversions { if let Some(&id)=ids.get(&item.geometry_item_id) {item.geometry_item_id=id;} }
    plan.next_available_express_id=plan.next_express_id+plan.created.len() as u32;
    ids
}
