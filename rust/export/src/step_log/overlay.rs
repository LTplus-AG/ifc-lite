// SPDX-License-Identifier: MPL-2.0
//! Replaying a mutation log into the overlay state the TypeScript exporter
//! reads: the port of `applyMutationsBatch` and the `MutablePropertyView`
//! setters it dispatches into.
//!
//! The parity definition is "what `importMutations(log)` leaves in a view
//! wired like the viewer's". The exporter never reads the history's values:
//! it reads the OVERLAY (property / quantity / attribute maps), and the
//! history only to learn which set names an entity touched. So this replays
//! the setters for their effect on those maps, and re-records the history
//! entries they would push, because which records a setter pushes (a
//! `deleteProperty` of a property that does not exist pushes none) decides
//! whether a set is regenerated at all.
//!
//! JavaScript `Map`/`Set` iteration is insertion order, and two orders reach
//! the file: a set's properties, and the order new members are appended. The
//! per-entity containers below are therefore ordered vectors, not hash maps.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::base::{pvt, BaseSets, PSet, Prop, QSet};
use super::jsval::{json_number, json_to_js_string};

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Op {
    Set,
    Delete,
}

#[derive(Debug, Clone)]
pub(crate) struct PropMut {
    pub(crate) op: Op,
    pub(crate) value: Value,
    pub(crate) value_type: Option<u8>,
    pub(crate) unit: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct QuantMut {
    pub(crate) op: Op,
    pub(crate) value: Option<f64>,
    pub(crate) quantity_type: Option<u8>,
}

/// A set-level history entry: which name an entity touched, and whether the
/// exporter files it under quantities (`CREATE/UPDATE/DELETE_QUANTITY`,
/// `DELETE_QUANTITY_SET`) or properties.
#[derive(Debug, Clone)]
pub(crate) struct Touched {
    pub(crate) entity: u32,
    pub(crate) set_name: String,
    pub(crate) quantity: bool,
}

/// A vector used as an insertion-ordered set.
fn ordered_insert<T: PartialEq>(v: &mut Vec<T>, item: T) {
    if !v.contains(&item) {
        v.push(item);
    }
}

#[derive(Default)]
pub(crate) struct Overlay {
    /// `(entity, set, member)` keys, per entity in insertion order.
    pub(crate) prop_keys: HashMap<u32, Vec<(String, String)>>,
    pub(crate) props: HashMap<(u32, String, String), PropMut>,
    pub(crate) new_psets: HashMap<u32, Vec<PSet>>,
    pub(crate) deleted_psets: HashSet<(u32, String)>,
    pub(crate) quant_keys: HashMap<u32, Vec<(String, String)>>,
    pub(crate) quants: HashMap<(u32, String, String), QuantMut>,
    pub(crate) new_qsets: HashMap<u32, Vec<QSet>>,
    pub(crate) deleted_qsets: HashSet<(u32, String)>,
    /// Named attribute edits, per entity in insertion order (last value wins
    /// in place, as `Map.set` on an existing key does).
    pub(crate) attributes: HashMap<u32, Vec<(String, String)>>,
    /// Entities in the order their first attribute edit arrived.
    pub(crate) attribute_order: Vec<u32>,
    pub(crate) history: Vec<Touched>,
    /// Created entities, in `newEntities` (insertion) order.
    pub(crate) new_entities: Vec<super::wire::LogNewEntity>,
    pub(crate) tombstones: HashSet<u32>,
    /// Positional edits per entity, slot order as `Map.set` leaves it.
    pub(crate) positional: HashMap<u32, Vec<(usize, Value)>>,
    /// `(newType, predefinedType)` per retyped entity.
    pub(crate) retypes: HashMap<u32, (String, Option<String>)>,
    /// Retyped ids in the order their first retype arrived (`Map` order).
    pub(crate) retype_order: Vec<u32>,
    /// Highest id the overlay allocated or restored (`nextAllocatedId`).
    pub(crate) next_allocated: u32,
}

impl Overlay {
    fn set_prop(&mut self, e: u32, set: &str, name: &str, m: PropMut) {
        ordered_insert(self.prop_keys.entry(e).or_default(), (set.to_string(), name.to_string()));
        self.props.insert((e, set.to_string(), name.to_string()), m);
    }

    pub(crate) fn drop_prop(&mut self, e: u32, set: &str, name: &str) {
        if self.props.remove(&(e, set.to_string(), name.to_string())).is_some() {
            if let Some(keys) = self.prop_keys.get_mut(&e) {
                keys.retain(|(s, n)| !(s == set && n == name));
                if keys.is_empty() {
                    self.prop_keys.remove(&e);
                }
            }
        }
    }

    pub(crate) fn set_quant(&mut self, e: u32, set: &str, name: &str, m: QuantMut) {
        ordered_insert(self.quant_keys.entry(e).or_default(), (set.to_string(), name.to_string()));
        self.quants.insert((e, set.to_string(), name.to_string()), m);
    }

    pub(crate) fn drop_quant(&mut self, e: u32, set: &str, name: &str) {
        if self.quants.remove(&(e, set.to_string(), name.to_string())).is_some() {
            if let Some(keys) = self.quant_keys.get_mut(&e) {
                keys.retain(|(s, n)| !(s == set && n == name));
                if keys.is_empty() {
                    self.quant_keys.remove(&e);
                }
            }
        }
    }

    fn new_pset(&mut self, e: u32, set: &str) -> Option<&mut PSet> {
        self.new_psets.get_mut(&e)?.iter_mut().find(|p| p.name == set)
    }

    fn remove_new_pset(&mut self, e: u32, set: &str) -> Option<PSet> {
        let sets = self.new_psets.get_mut(&e)?;
        let at = sets.iter().position(|p| p.name == set)?;
        let removed = sets.remove(at);
        if sets.is_empty() {
            self.new_psets.remove(&e);
        }
        Some(removed)
    }

    pub(crate) fn remove_new_qset(&mut self, e: u32, set: &str) -> Option<QSet> {
        let sets = self.new_qsets.get_mut(&e)?;
        let at = sets.iter().position(|q| q.name == set)?;
        let removed = sets.remove(at);
        if sets.is_empty() {
            self.new_qsets.remove(&e);
        }
        Some(removed)
    }

    /// `Map.set(name, pset)` on an entity's new-set map: in place when the
    /// name is there, appended otherwise.
    fn put_new_pset(&mut self, e: u32, pset: PSet) {
        let sets = self.new_psets.entry(e).or_default();
        match sets.iter_mut().find(|p| p.name == pset.name) {
            Some(slot) => *slot = pset,
            None => sets.push(pset),
        }
    }

    pub(crate) fn put_new_qset(&mut self, e: u32, qset: QSet) {
        let sets = self.new_qsets.entry(e).or_default();
        match sets.iter_mut().find(|q| q.name == qset.name) {
            Some(slot) => *slot = qset,
            None => sets.push(qset),
        }
    }

    pub(crate) fn touch(&mut self, e: u32, set: &str, quantity: bool) {
        self.history.push(Touched { entity: e, set_name: set.to_string(), quantity });
    }

    /// `getPropertyValue`.
    fn property_value(&self, base: &mut BaseSets<'_, '_>, e: u32, set: &str, name: &str) -> Value {
        if let Some(m) = self.props.get(&(e, set.to_string(), name.to_string())) {
            return if m.op == Op::Delete { Value::Null } else { m.value.clone() };
        }
        if let Some(p) = self
            .new_psets
            .get(&e)
            .and_then(|s| s.iter().find(|p| p.name == set))
            .and_then(|p| p.properties.iter().find(|pr| pr.name == name))
        {
            return p.value.clone();
        }
        for pset in base.psets(e) {
            if pset.name != set {
                continue;
            }
            if let Some(p) = pset.properties.iter().find(|p| p.name == name) {
                return p.value.clone();
            }
        }
        Value::Null
    }

    /// `setProperty(entity, set, name, value, valueType)` as the replay calls it.
    pub(crate) fn set_property(&mut self, base: &mut BaseSets<'_, '_>, e: u32, set: &str, name: &str, value: Value, ty: u8) {
        let in_base = base.psets(e).iter().any(|p| p.name == set);
        let in_new = self.new_pset(e, set).is_some();
        let prop = Prop { name: name.to_string(), ty, value: value.clone(), unit: None, data_type: None };
        if !in_base && !in_new {
            self.put_new_pset(e, PSet { name: set.to_string(), global_id: String::new(), properties: vec![prop] });
        } else if in_new {
            let pset = self.new_pset(e, set).expect("checked above");
            match pset.properties.iter_mut().find(|p| p.name == name) {
                Some(slot) => *slot = prop,
                None => pset.properties.push(prop),
            }
        }
        self.set_prop(e, set, name, PropMut { op: Op::Set, value, value_type: Some(ty), unit: None });
        self.touch(e, set, false);
    }

    /// `deleteProperty`.
    pub(crate) fn delete_property(&mut self, base: &mut BaseSets<'_, '_>, e: u32, set: &str, name: &str) {
        let old = self.property_value(base, e, set, name);
        let in_new =
            self.new_pset(e, set).is_some_and(|p| p.properties.iter().any(|pr| pr.name == name));
        if old.is_null() && !in_new {
            return;
        }
        let in_base = base.psets(e).iter().any(|p| p.name == set && p.properties.iter().any(|pr| pr.name == name));
        if in_base {
            self.set_prop(e, set, name, PropMut { op: Op::Delete, value: Value::Null, value_type: None, unit: None });
        } else {
            self.drop_prop(e, set, name);
        }
        let emptied = match self.new_pset(e, set) {
            Some(p) => {
                p.properties.retain(|pr| pr.name != name);
                p.properties.is_empty()
            }
            None => false,
        };
        if emptied {
            self.remove_new_pset(e, set);
        }
        self.touch(e, set, false);
    }

    /// `createPropertySet`.
    pub(crate) fn create_property_set(&mut self, e: u32, set: &str, members: &[Value]) {
        let mut properties = Vec::new();
        for m in members {
            let name = m.get("name").map(json_to_js_string).unwrap_or_else(|| "undefined".to_string());
            let value = m.get("value").cloned().unwrap_or(Value::Null);
            let ty = m.get("type").and_then(json_number).map_or(pvt::STRING, |n| n as u8);
            let unit = m.get("unit").and_then(Value::as_str).map(str::to_string);
            properties.push(Prop { name, ty, value, unit, data_type: None });
        }
        self.put_new_pset(e, PSet { name: set.to_string(), global_id: String::new(), properties: properties.clone() });
        for p in properties {
            self.set_prop(e, set, &p.name, PropMut { op: Op::Set, value: p.value, value_type: Some(p.ty), unit: p.unit });
        }
        self.touch(e, set, false);
    }

    /// `deletePropertySet`.
    pub(crate) fn delete_property_set(&mut self, base: &mut BaseSets<'_, '_>, e: u32, set: &str) {
        if let Some(removed) = self.remove_new_pset(e, set) {
            for p in removed.properties {
                self.drop_prop(e, set, &p.name);
            }
        }
        for pset in base.psets(e) {
            if pset.name != set {
                continue;
            }
            self.deleted_psets.insert((e, set.to_string()));
            for p in pset.properties {
                self.set_prop(e, set, &p.name, PropMut { op: Op::Delete, value: Value::Null, value_type: None, unit: None });
            }
        }
        self.touch(e, set, false);
    }

    pub(crate) fn set_attribute(&mut self, e: u32, name: &str, value: String) {
        let attrs = self.attributes.entry(e).or_default();
        if attrs.is_empty() && !self.attribute_order.contains(&e) {
            self.attribute_order.push(e);
        }
        match attrs.iter_mut().find(|(n, _)| n == name) {
            Some(slot) => slot.1 = value,
            None => attrs.push((name.to_string(), value)),
        }
    }
}
