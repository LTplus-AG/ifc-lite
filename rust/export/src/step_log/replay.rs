// SPDX-License-Identifier: MPL-2.0
//! The quantity setters of the replay, and `applyMutationsBatch` itself; the
//! property setters and the overlay state are in [`super::overlay`].

use serde_json::Value;

use super::base::{qty, BaseSets, QSet, Quantity};
use super::jsval::{js_to_number, json_number, json_to_js_string};
use super::overlay::{Op, Overlay, QuantMut};
use super::base::pvt;
use super::wire::{LogMutation, MutationKind};

impl Overlay {
    /// `setQuantity`.
    pub(crate) fn set_quantity(&mut self, base: &mut BaseSets<'_, '_>, e: u32, set: &str, name: &str, value: f64, ty: u8) {
        let in_base = base.qsets(e).iter().any(|q| q.name == set);
        let in_new = self.new_qsets.get(&e).is_some_and(|s| s.iter().any(|q| q.name == set));
        let quantity = Quantity { name: name.to_string(), ty, value };
        if !in_base && !in_new {
            self.put_new_qset(e, QSet { name: set.to_string(), quantities: vec![quantity] });
        } else if in_new {
            let qset = self.new_qsets.get_mut(&e).and_then(|s| s.iter_mut().find(|q| q.name == set)).expect("checked");
            match qset.quantities.iter_mut().find(|q| q.name == name) {
                Some(slot) => *slot = quantity,
                None => qset.quantities.push(quantity),
            }
        }
        self.set_quant(e, set, name, QuantMut { op: Op::Set, value: Some(value), quantity_type: Some(ty) });
        self.touch(e, set, true);
    }

    /// `createQuantitySet`.
    pub(crate) fn create_quantity_set(&mut self, e: u32, set: &str, members: &[Value]) {
        let mut quantities = Vec::new();
        for m in members {
            let name = m.get("name").map(json_to_js_string).unwrap_or_else(|| "undefined".to_string());
            let value = m.get("value").map(js_to_number).unwrap_or(f64::NAN);
            let ty = m.get("quantityType").and_then(json_number).map_or(qty::COUNT, |n| n as u8);
            quantities.push(Quantity { name, ty, value });
        }
        self.put_new_qset(e, QSet { name: set.to_string(), quantities: quantities.clone() });
        for q in quantities {
            self.set_quant(e, set, &q.name, QuantMut { op: Op::Set, value: Some(q.value), quantity_type: Some(q.ty) });
        }
        self.touch(e, set, true);
    }

    /// `deleteQuantity` plus the replay's `ensureQuantityDeletion`: the DELETE
    /// marker and the history record survive even when the member exists in
    /// neither the base nor the session.
    pub(crate) fn delete_quantity(&mut self, base: &mut BaseSets<'_, '_>, e: u32, set: &str, name: &str) {
        let in_base = base.qsets(e).iter().any(|q| q.name == set && q.quantities.iter().any(|x| x.name == name));
        let in_new = self
            .new_qsets
            .get(&e)
            .and_then(|s| s.iter().find(|q| q.name == set))
            .is_some_and(|q| q.quantities.iter().any(|x| x.name == name));
        if in_base || in_new {
            if in_base {
                self.set_quant(e, set, name, QuantMut { op: Op::Delete, value: None, quantity_type: None });
            } else {
                self.drop_quant(e, set, name);
            }
            let emptied = match self.new_qsets.get_mut(&e).and_then(|s| s.iter_mut().find(|q| q.name == set)) {
                Some(q) => {
                    q.quantities.retain(|x| x.name != name);
                    q.quantities.is_empty()
                }
                None => false,
            };
            if emptied {
                self.remove_new_qset(e, set);
            }
        }
        self.set_quant(e, set, name, QuantMut { op: Op::Delete, value: None, quantity_type: None });
        self.touch(e, set, true);
    }

    /// `deleteQuantitySet`, plus the replay's unconditional mask.
    pub(crate) fn delete_quantity_set(&mut self, base: &mut BaseSets<'_, '_>, e: u32, set: &str) {
        if let Some(removed) = self.remove_new_qset(e, set) {
            for q in removed.quantities {
                self.drop_quant(e, set, &q.name);
            }
        }
        for qset in base.qsets(e) {
            if qset.name != set {
                continue;
            }
            self.deleted_qsets.insert((e, set.to_string()));
            for q in qset.quantities {
                self.set_quant(e, set, &q.name, QuantMut { op: Op::Delete, value: None, quantity_type: None });
            }
        }
        self.deleted_qsets.insert((e, set.to_string()));
        self.touch(e, set, true);
    }
}

/// Why a log cannot be applied by this writer.
#[derive(Debug)]
pub(crate) struct Unsupported(pub(crate) String);

/// The kinds this writer applies. A log carrying any other kind is refused
/// whole rather than exported without it: a file that looks like a saved edit
/// and silently lacks one is the failure this writer exists to prevent.
fn supported(kind: MutationKind) -> bool {
    matches!(
        kind,
        MutationKind::CreateProperty
            | MutationKind::UpdateProperty
            | MutationKind::DeleteProperty
            | MutationKind::CreatePropertySet
            | MutationKind::DeletePropertySet
            | MutationKind::CreateQuantity
            | MutationKind::UpdateQuantity
            | MutationKind::DeleteQuantity
            | MutationKind::DeleteQuantitySet
            | MutationKind::UpdateAttribute
    )
}

/// `applyMutationsBatch`.
pub(crate) fn replay(mutations: &[LogMutation], base: &mut BaseSets<'_, '_>) -> Result<Overlay, Unsupported> {
    if let Some(m) = mutations.iter().find(|m| !supported(m.kind)) {
        return Err(Unsupported(match m.kind {
            // `applyMutationsBatch` warns and skips a type it does not know,
            // so the TypeScript save writes the file without that edit. A
            // native save refuses instead: the record could be an edit a
            // newer producer made, and dropping it is silent data loss.
            MutationKind::Unknown => {
                format!("a mutation of an unrecognised `type` (entity #{}) cannot be applied", m.entity_id)
            }
            kind => format!("mutation kind {kind:?} (entity #{}) is not supported by this writer yet", m.entity_id),
        }));
    }
    if let Some(m) = mutations.iter().find(|m| {
        m.kind == MutationKind::UpdateAttribute && m.new_value.as_ref().is_some_and(Value::is_null)
    }) {
        // `setAttribute(id, name, null)` leaves a value the TypeScript
        // exporter cannot serialize (it throws), and `importMutations` drops
        // the record. Neither writes a file carrying the edit, so neither
        // does this one: refused, not silently skipped. `''` clears a slot.
        return Err(Unsupported(format!(
            "UPDATE_ATTRIBUTE {} on entity #{} has a null newValue, which has no STEP spelling; clear an attribute with an empty string",
            m.attribute_name.as_deref().unwrap_or("?"),
            m.entity_id
        )));
    }
    let mut o = Overlay::default();
    for m in mutations {
        let e = m.entity_id;
        let set = m.pset_name.as_deref().filter(|s| !s.is_empty());
        let name = m.prop_name.as_deref().filter(|s| !s.is_empty());
        match m.kind {
            MutationKind::CreateProperty | MutationKind::UpdateProperty => {
                if let (Some(set), Some(name), Some(value)) = (set, name, m.new_value.as_ref()) {
                    let ty = m.value_type.map_or(pvt::STRING, |t| t as u8);
                    o.set_property(base, e, set, name, value.clone(), ty);
                }
            }
            MutationKind::DeleteProperty => {
                if let (Some(set), Some(name)) = (set, name) {
                    o.delete_property(base, e, set, name);
                }
            }
            MutationKind::DeletePropertySet => {
                if let Some(set) = set {
                    o.delete_property_set(base, e, set);
                }
            }
            MutationKind::DeleteQuantitySet => {
                if let Some(set) = set {
                    o.delete_quantity_set(base, e, set);
                }
            }
            MutationKind::DeleteQuantity => {
                if let (Some(set), Some(name)) = (set, name) {
                    o.delete_quantity(base, e, set, name);
                }
            }
            MutationKind::CreateQuantity | MutationKind::UpdateQuantity => match (set, name, m.new_value.as_ref()) {
                (Some(set), Some(name), Some(value)) => {
                    let ty = m.quantity_type.map_or(qty::COUNT, |t| t as u8);
                    o.set_quantity(base, e, set, name, js_to_number(value), ty);
                }
                (Some(set), _, Some(Value::Array(members))) if m.kind == MutationKind::CreateQuantity => {
                    o.create_quantity_set(e, set, members);
                }
                _ => {}
            },
            MutationKind::UpdateAttribute => {
                if let (Some(attr), Some(value)) = (m.attribute_name.as_deref().filter(|a| !a.is_empty()), m.new_value.as_ref()) {
                    o.set_attribute(e, attr, json_to_js_string(value));
                }
            }
            MutationKind::CreatePropertySet => {
                if let (Some(set), Some(Value::Array(members))) = (set, m.new_value.as_ref()) {
                    o.create_property_set(e, set, members);
                }
            }
            // Every other kind was refused before the loop.
            _ => {}
        }
    }
    Ok(o)
}
