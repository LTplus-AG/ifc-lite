// SPDX-License-Identifier: MPL-2.0
//! The entity-level setters of the replay: `restoreNewEntity`, `deleteEntity`
//! (with the overlay purge a created entity's deletion performs),
//! `setPositionalAttribute` and `setEntityType`.

use serde_json::Value;

use super::overlay::Overlay;
use super::wire::LogNewEntity;

impl Overlay {
    pub(crate) fn is_created(&self, id: u32) -> bool {
        self.new_entities.iter().any(|e| e.express_id == id)
    }

    pub(crate) fn created(&self, id: u32) -> Option<&LogNewEntity> {
        self.new_entities.iter().find(|e| e.express_id == id)
    }

    /// `restoreNewEntity`: `Map.set` (in place when the id is there).
    pub(crate) fn restore(&mut self, entity: LogNewEntity) {
        self.tombstones.remove(&entity.express_id);
        self.next_allocated = self.next_allocated.max(entity.express_id);
        match self.new_entities.iter_mut().find(|e| e.express_id == entity.express_id) {
            Some(slot) => *slot = entity,
            None => self.new_entities.push(entity),
        }
    }

    /// `deleteEntity`.
    pub(crate) fn delete_entity(&mut self, id: u32) {
        if let Some(at) = self.new_entities.iter().position(|e| e.express_id == id) {
            self.new_entities.remove(at);
            self.tombstones.insert(id);
            self.purge(id);
            return;
        }
        self.tombstones.insert(id);
    }

    /// `stashAndPurgeEntityOverlay`: everything the session recorded against a
    /// created entity goes with it, history included, so its set names no
    /// longer drive the exporter's grouping.
    fn purge(&mut self, id: u32) {
        for (set, name) in self.prop_keys.get(&id).cloned().unwrap_or_default() {
            self.drop_prop(id, &set, &name);
        }
        for (set, name) in self.quant_keys.get(&id).cloned().unwrap_or_default() {
            self.drop_quant(id, &set, &name);
        }
        self.attributes.remove(&id);
        self.attribute_order.retain(|e| *e != id);
        self.positional.remove(&id);
        self.retypes.remove(&id);
        self.retype_order.retain(|e| *e != id);
        self.new_psets.remove(&id);
        self.new_qsets.remove(&id);
        self.deleted_psets.retain(|(e, _)| *e != id);
        self.deleted_qsets.retain(|(e, _)| *e != id);
        self.history.retain(|t| t.entity != id);
    }

    /// `setPositionalAttribute`.
    pub(crate) fn set_positional(&mut self, id: u32, index: usize, value: Value) {
        let slots = self.positional.entry(id).or_default();
        match slots.iter_mut().find(|(i, _)| *i == index) {
            Some(slot) => slot.1 = value,
            None => slots.push((index, value)),
        }
    }

    /// `setEntityType`'s overlay write.
    pub(crate) fn set_retype(&mut self, id: u32, new_type: String, predefined: Option<String>) {
        if self.retypes.insert(id, (new_type, predefined)).is_none() {
            self.retype_order.push(id);
        }
    }

    /// The positional edits queued for `id`.
    pub(crate) fn positionals(&self, id: u32) -> &[(usize, Value)] {
        self.positional.get(&id).map(Vec::as_slice).unwrap_or(&[])
    }
}

/// `setEntityType`'s name check: `/^[Ii][Ff][Cc][A-Za-z][A-Za-z0-9_]*$/`.
pub(crate) fn is_entity_name(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() >= 4
        && b[..3].eq_ignore_ascii_case(b"IFC")
        && b[3].is_ascii_alphabetic()
        && b[4..].iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}
