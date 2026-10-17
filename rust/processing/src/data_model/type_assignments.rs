// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Which `IfcTypeObject` defines an occurrence (D42, EXPORT-DATA-3, C6-9).
//!
//! A file may type one object twice through `IfcRelDefinesByType`, which the
//! schema forbids and exporters do anyway. The rule, in one place:
//!
//! * **First wins, in file order.** [`TypeAssignments::type_of`] answers with
//!   the first type recorded. `typeIds[0]` in the browser, the inheritance
//!   merge and `ifc_lite_export::relationships()` all read it, so they cannot
//!   disagree (the last one used to take the last).
//! * **Conflicts are recorded**, not dropped: [`TypeAssignments::conflicts`]
//!   lists each object typed by more than one distinct type, in the order the
//!   conflict was first seen, with its types in file order.
//! * Two policies read the conflict list and stay what they were: quantity
//!   analysis treats a conflicted product as untyped, and the rebar schedule
//!   takes the first *valid* `IfcReinforcingBarType` among
//!   [`TypeAssignments::candidates`].

use rustc_hash::FxHashMap;

/// What recording one assignment did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recorded {
    /// The object had no type yet.
    First,
    /// The object already had this type.
    Same,
    /// The object already had a different type; this is the first time that
    /// is seen for the object.
    NewConflict,
    /// A further assignment for an object already in conflict.
    Conflict,
}

#[derive(Debug, Clone, Default)]
pub struct TypeAssignments {
    first: FxHashMap<u32, u32>,
    /// Object to its distinct types in file order, only for conflicted objects.
    all: FxHashMap<u32, Vec<u32>>,
    order: Vec<u32>,
}

impl TypeAssignments {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record `object` as defined by `type_id`. Call in file order.
    pub fn record(&mut self, object: u32, type_id: u32) -> Recorded {
        let Some(&first) = self.first.get(&object) else {
            self.first.insert(object, type_id);
            return Recorded::First;
        };
        if let Some(types) = self.all.get_mut(&object) {
            if !types.contains(&type_id) {
                types.push(type_id);
            }
            return Recorded::Conflict;
        }
        if first == type_id {
            return Recorded::Same;
        }
        self.all.insert(object, vec![first, type_id]);
        self.order.push(object);
        Recorded::NewConflict
    }

    /// The first type recorded for `object`.
    pub fn type_of(&self, object: u32) -> Option<u32> {
        self.first.get(&object).copied()
    }

    /// Every object's first type.
    pub fn first_wins(&self) -> &FxHashMap<u32, u32> {
        &self.first
    }

    /// The distinct types recorded for `object`, in file order.
    pub fn candidates(&self, object: u32) -> Vec<u32> {
        match self.all.get(&object) {
            Some(types) => types.clone(),
            None => self.first.get(&object).copied().into_iter().collect(),
        }
    }

    pub fn is_conflicted(&self, object: u32) -> bool {
        self.all.contains_key(&object)
    }

    /// Objects typed by more than one distinct type, in the order the conflict
    /// was first seen, each with its types in file order.
    pub fn conflicts(&self) -> Vec<(u32, Vec<u32>)> {
        self.order.iter().map(|&object| (object, self.all[&object].clone())).collect()
    }

    /// Objects with exactly one type: the "conflict means none" view.
    pub fn unambiguous(&self) -> impl Iterator<Item = (u32, u32)> + '_ {
        self.first.iter().filter(|(object, _)| !self.all.contains_key(object)).map(|(&o, &t)| (o, t))
    }
}

#[cfg(test)]
#[path = "type_assignments_tests.rs"]
mod tests;
