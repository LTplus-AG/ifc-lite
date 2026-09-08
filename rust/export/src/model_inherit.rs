// SPDX-License-Identifier: MPL-2.0
//! Merging an occurrence's own property/quantity sets with the ones it inherits
//! from its `IfcTypeObject`.
//!
//! This is the Rust half of `packages/parser/src/property-set-merge.ts`. The
//! rule is deliberately per-PROPERTY rather than per-SET, which is the fix
//! issue #1913 made on the TS side: replacing a whole same-named set with the
//! occurrence's version drops the type-only properties inside it, and those
//! then become invisible to IDS and to schedules. Keep the two implementations
//! in step; `model_inherit_tests.rs` mirrors the TS test cases.
//!
//! Split from `model.rs` under the house rule (AGENTS.md).

use crate::model::{PropValue, PropertySet, QuantitySet, QuantityValue};
use std::collections::HashMap;

/// A named set of named things, so one merge serves both property sets and
/// quantity sets rather than duplicating the rule for each and letting them
/// drift.
pub(super) trait NamedSet {
    type Item: Clone;
    fn set_name(&self) -> &str;
    fn item_names(&self) -> Vec<&str>;
    fn items(&self) -> &[Self::Item];
    fn items_mut(&mut self) -> &mut Vec<Self::Item>;
    fn item_name(item: &Self::Item) -> &str;
}

impl NamedSet for PropertySet {
    type Item = PropValue;
    fn set_name(&self) -> &str {
        &self.name
    }
    fn item_names(&self) -> Vec<&str> {
        self.properties.iter().map(|p| p.name.as_str()).collect()
    }
    fn items(&self) -> &[PropValue] {
        &self.properties
    }
    fn items_mut(&mut self) -> &mut Vec<PropValue> {
        &mut self.properties
    }
    fn item_name(item: &PropValue) -> &str {
        &item.name
    }
}

impl NamedSet for QuantitySet {
    type Item = QuantityValue;
    fn set_name(&self) -> &str {
        &self.name
    }
    fn item_names(&self) -> Vec<&str> {
        self.quantities.iter().map(|q| q.name.as_str()).collect()
    }
    fn items(&self) -> &[QuantityValue] {
        &self.quantities
    }
    fn items_mut(&mut self) -> &mut Vec<QuantityValue> {
        &mut self.quantities
    }
    fn item_name(item: &QuantityValue) -> &str {
        &item.name
    }
}

/// Merge `inherited` (from the occurrence's type) into `own`, occurrence wins.
///
/// Mirrors `mergeInheritedPropertySets`:
///
/// * An inherited set whose name matches no own set is appended whole.
/// * An inherited set whose name matches own set(s) contributes only the
///   properties those sets do not already define, appended after the own ones.
///   A name collision inside a set is therefore won by the occurrence.
/// * Own sets keep their positions and order; appended inherited sets follow.
///
/// Two subtleties carried over deliberately, because both change the output:
///
/// 1. An occurrence can carry several same-named sets (one per
///    `IfcRelDefinesByProperties`), so the name index maps to EVERY matching
///    index and each of them receives the additions.
/// 2. An appended inherited set is NOT registered in the name index, so a
///    second inherited set of the same name lands as its own entry rather than
///    being folded into the first. Registering it would silently merge two
///    distinct type sets.
pub(super) fn merge_inherited<T: NamedSet>(mut own: Vec<T>, inherited: Vec<T>) -> Vec<T> {
    if inherited.is_empty() {
        return own;
    }

    let mut indices_by_name: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, set) in own.iter().enumerate() {
        indices_by_name
            .entry(set.set_name().to_string())
            .or_default()
            .push(i);
    }

    for inherited_set in inherited {
        let Some(indices) = indices_by_name.get(inherited_set.set_name()) else {
            // No own set by this name: take the whole thing, and deliberately
            // leave the index untouched (see subtlety 2 above).
            own.push(inherited_set);
            continue;
        };

        for &i in indices {
            let existing: Vec<String> = own[i].item_names().into_iter().map(String::from).collect();
            let additions: Vec<T::Item> = inherited_set
                .items()
                .iter()
                .filter(|item| !existing.iter().any(|n| n == T::item_name(item)))
                .cloned()
                .collect();
            if !additions.is_empty() {
                own[i].items_mut().extend(additions);
            }
        }
    }

    own
}

#[cfg(test)]
#[path = "model_inherit_tests.rs"]
mod tests;
