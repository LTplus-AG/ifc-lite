// SPDX-License-Identifier: MPL-2.0
//! Elements a delete leaves outside the spatial tree, for the report's
//! findings: `removed` alone does not say so.

use std::collections::{HashMap, HashSet};

use super::attrs::attribute_index;
use super::index::FileIndex;
use super::removal::RemovalReason;
use super::types::ValidationFinding;

const CONTAINMENT: &str = "IFCRELCONTAINEDINSPATIALSTRUCTURE";
const AGGREGATION: &str = "IFCRELAGGREGATES";

fn is_spatial(schema: &str, class: &str) -> bool {
    ["IFCSPATIALSTRUCTUREELEMENT", "IFCSPATIALELEMENT"].iter().any(|p| ifc_lite_core::is_subtype_of_for_schema(schema, class, p))
}

/// `(relating attribute, related attribute)` of a relationship that places
/// things in the spatial tree.
fn slots(schema: &str, rel_type: &str) -> Option<(usize, usize)> {
    let (relating, related) = match rel_type {
        CONTAINMENT => ("RelatingStructure", "RelatedElements"),
        AGGREGATION => ("RelatingObject", "RelatedObjects"),
        _ => return None,
    };
    Some((attribute_index(schema, rel_type, relating)?, attribute_index(schema, rel_type, related)?))
}

/// A containment or aggregation relationship that went because its relating
/// object did, while some of what it related stayed. Such an element is no
/// longer in the spatial tree unless the removed relationship put it there
/// from a spatial element (an aggregation of an assembly does not) and it
/// has no other surviving place in it.
pub(super) fn unplaced_by_removed_structure(
    index: &FileIndex,
    schema: &str,
    removed: &HashSet<u32>,
    reasons: &HashMap<u32, RemovalReason>,
) -> Vec<ValidationFinding> {
    let mut rels: Vec<u32> = removed.iter().copied().filter(|id| reasons.get(id) == Some(&RemovalReason::Dangling)).collect();
    rels.sort_unstable();
    let mut out = Vec::new();
    for rel in rels {
        let Some(rel_type) = index.type_of(rel) else { continue };
        let Some((relating_idx, related_idx)) = slots(schema, &rel_type) else { continue };
        let Some(attrs) = index.attrs(rel) else { continue };
        let parent = attrs.get(relating_idx).and_then(|a| a.scalar);
        if rel_type == AGGREGATION && !parent.and_then(|p| index.type_of(p)).is_some_and(|c| is_spatial(schema, &c)) {
            continue;
        }
        let children = attrs.get(related_idx).and_then(|a| a.list.as_ref()).into_iter().flatten().flatten();
        for &child in children.filter(|c| !removed.contains(c)) {
            if still_placed(index, schema, removed, rel, child) {
                continue;
            }
            let parent = parent.map_or_else(String::new, |p| format!(" #{p}"));
            let label = if rel_type == AGGREGATION { "parent" } else { "container" };
            out.push(ValidationFinding {
                express_id: Some(child),
                message: format!("no longer in the spatial tree: the {label}{parent} it was related to in #{rel} was deleted"),
            });
        }
    }
    out
}

/// Whether `child` is still contained in, or aggregated under, a surviving
/// spatial element by a relationship other than `except`.
fn still_placed(index: &FileIndex, schema: &str, removed: &HashSet<u32>, except: u32, child: u32) -> bool {
    index.referrers(child).iter().any(|&(rel, idx)| {
        if rel == except || removed.contains(&rel) {
            return false;
        }
        let Some(rel_type) = index.type_of(rel) else { return false };
        let Some((relating_idx, related_idx)) = slots(schema, &rel_type) else { return false };
        if idx != related_idx {
            return false;
        }
        let Some(parent) = index.attrs(rel).and_then(|a| a.get(relating_idx).and_then(|a| a.scalar)) else { return false };
        !removed.contains(&parent) && index.type_of(parent).is_some_and(|c| is_spatial(schema, &c))
    })
}
