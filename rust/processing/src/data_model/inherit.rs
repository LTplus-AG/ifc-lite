// SPDX-License-Identifier: MPL-2.0
//! Merging an occurrence's own property/quantity sets with the ones it inherits
//! from its `IfcTypeObject`.
//!
//! This is the Rust half of `packages/parser/src/property-set-merge.ts`. The
//! rule is deliberately per-PROPERTY rather than per-SET, which is the fix
//! issue #1913 made on the TS side: replacing a whole same-named set with the
//! occurrence's version drops the type-only properties inside it, and those
//! then become invisible to IDS and to schedules. Keep the two implementations
//! in step; `inherit_tests.rs` mirrors the TS test cases.
//!
//! Moved from `rust/export/src/model_inherit.rs` (C6-8, #7783).

use super::property::PropertyDecoder;
use super::render::flat::{ref_list, resolve_type_sets};
use super::rows::{Inherited, PropValue, PropertySet, QuantitySet, QuantityValue};
use ifc_lite_core::{slot, EntityDecoder};
use std::collections::{HashMap, HashSet};
use std::ops::Range;

/// A named set of named things, so one merge serves both property sets and
/// quantity sets rather than duplicating the rule for each and letting them
/// drift.
pub(super) trait NamedSet {
    type Item: Clone;
    fn set_name(&self) -> &str;
    fn items(&self) -> &[Self::Item];
    fn items_mut(&mut self) -> &mut Vec<Self::Item>;
    fn item_name(item: &Self::Item) -> &str;
}

impl NamedSet for PropertySet {
    type Item = PropValue;
    fn set_name(&self) -> &str {
        &self.name
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

/// Merge the sets an occurrence inherits from its type into its `own`,
/// occurrence wins, per entry rather than per set (#1913). Mirrors
/// `mergeInheritedPropertySets`:
///
/// * An inherited set whose name matches no own set is appended whole.
/// * An inherited set whose name matches own set(s) contributes to EACH of
///   them the entries that set does not already define, appended after its
///   own. A collision is therefore won by the occurrence, and the type-only
///   entries beside it survive. Every same-named own set is topped up, not
///   just the first: an occurrence can carry several (one per
///   `IfcRelDefinesByProperties`).
/// * Own sets keep their positions and order; appended inherited sets follow.
/// * An appended inherited set is not matched by a later inherited set of the
///   same name, so two distinct type sets are never folded into one.
/// * An unnamed set (`$` in the file, `""` here) matches nothing: an absent
///   name is no evidence that two sets are the same one.
///
/// Returns the merged sets and, per merged set, the range of its entries that
/// came from the type: own entries always precede inherited ones within a set.
/// The ranges are empty when nothing is inherited.
pub(super) fn merge_inherited<T: NamedSet + Clone>(mut own: Vec<T>, inherited: &[T]) -> (Vec<T>, Vec<Range<usize>>) {
    if inherited.is_empty() {
        return (own, Vec::new());
    }
    // Only own sets are matched: an appended inherited set never is.
    let own_count = own.len();
    let mut ranges: Vec<Range<usize>> = own.iter().map(|s| s.items().len()..s.items().len()).collect();
    for set in inherited {
        let name = set.set_name();
        let matches: Vec<usize> =
            if name.is_empty() { Vec::new() } else { (0..own_count).filter(|&i| own[i].set_name() == name).collect() };
        if matches.is_empty() {
            ranges.push(0..set.items().len());
            own.push(set.clone());
            continue;
        }
        for i in matches {
            let defined: HashSet<&str> = own[i].items().iter().map(T::item_name).collect();
            let additions: Vec<T::Item> =
                set.items().iter().filter(|item| !defined.contains(T::item_name(item))).cloned().collect();
            own[i].items_mut().extend(additions);
            ranges[i].end = own[i].items().len();
        }
    }
    (own, ranges)
}

/// What a type's sets resolve to, memoized per type id: a Revit export types
/// thousands of walls off one IfcWallType, and re-decoding its sets for each
/// would turn a constant cost into a linear one.
pub(super) type TypeSetCache = HashMap<u32, (Vec<PropertySet>, Vec<QuantitySet>)>;

/// Fold into an occurrence's own sets what it inherits from `type_id`, and
/// report which entries came from the type. The type's sets are its
/// `HasPropertySets`, read from the type entity itself (the pass-1 candidate
/// list holds only types with RepresentationMaps, and the common inheriting
/// type has none), then the sets `IfcRelDefinesByProperties` attaches to it.
pub(super) fn inherit_from_type(
    cache: &mut TypeSetCache,
    type_id: u32,
    (props, decoder, defs_by_object): (&mut PropertyDecoder, &mut EntityDecoder, &HashMap<u32, Vec<u32>>),
    property_sets: Vec<PropertySet>,
    quantity_sets: Vec<QuantitySet>,
) -> (Vec<PropertySet>, Vec<QuantitySet>, Inherited) {
    let type_sets = cache.entry(type_id).or_insert_with_key(|&tid| {
        let has_sets = decoder
            .decode_by_id(tid)
            .ok()
            .map(|t| ref_list(t.attr(slot::IfcTypeObject::HAS_PROPERTY_SETS)))
            .unwrap_or_default();
        let related = defs_by_object.get(&tid).map_or(&[][..], Vec::as_slice);
        resolve_type_sets(props, decoder, has_sets, related)
    });
    let (psets, inherited_props) = merge_inherited(property_sets, &type_sets.0);
    let (qsets, inherited_qtys) = merge_inherited(quantity_sets, &type_sets.1);
    (psets, qsets, Inherited::new(inherited_props, inherited_qtys))
}

#[cfg(test)]
#[path = "inherit_tests.rs"]
mod tests;
