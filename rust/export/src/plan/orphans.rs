// SPDX-License-Identifier: MPL-2.0
//! Elements a delete leaves outside the spatial tree, for the report's
//! findings: `removed` alone does not say so.

use std::collections::{HashMap, HashSet};

use super::attrs::{attribute_index, in_structure};
use super::index::FileIndex;
use super::removal::RemovalReason;
use super::types::ValidationFinding;

const CONTAINMENT: &str = "IFCRELCONTAINEDINSPATIALSTRUCTURE";
const AGGREGATION: &str = "IFCRELAGGREGATES";

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

/// A containment or aggregation relationship the plan deleted, or that went
/// because its relating object (or another record it named) did, while some
/// of what it related stayed. A contained element has lost its container. An aggregated one is
/// out of the tree only when its parent was a place in it (the project or a
/// spatial structure element), not an assembly, a spatial zone or an external
/// spatial element. Known limit: a part placed only through a deleted
/// assembly, or a zone only under a deleted zone, is not reported. IFC gives
/// an element at most one container and one parent, so the removed
/// relationship was its only place in the tree and no other relationship
/// needs reading.
pub(super) fn unplaced_by_removed_structure(
    index: &FileIndex,
    schema: &str,
    removed: &HashSet<u32>,
    reasons: &HashMap<u32, RemovalReason>,
) -> Vec<ValidationFinding> {
    // A relationship the plan deleted, or one that went because a record it
    // named did. A replaced one moved its objects somewhere else.
    let gone = |id: &u32| matches!(reasons.get(id), Some(RemovalReason::Dangling | RemovalReason::Requested));
    let mut rels: Vec<u32> = removed.iter().copied().filter(gone).collect();
    rels.sort_unstable();
    let mut out = Vec::new();
    for rel in rels {
        let Some(rel_type) = index.type_of(rel) else { continue };
        let Some((relating_idx, related_idx)) = slots(schema, &rel_type) else { continue };
        let Some(attrs) = index.attrs(rel) else { continue };
        let parent = attrs.get(relating_idx).and_then(|a| a.scalar);
        // Containment always placed its elements (RelatingStructure is an
        // IfcSpatialElement); an aggregation did only under a place in the tree.
        if rel_type == AGGREGATION && !parent.and_then(|p| index.type_of(p)).is_some_and(|c| in_structure(schema, &c)) {
            continue;
        }
        let label = if rel_type == AGGREGATION { "parent" } else { "container" };
        // The relationship is gone either way; say why.
        let cause = match parent {
            Some(p) if removed.contains(&p) => format!("the {label} #{p} it was related to in #{rel} was deleted"),
            Some(p) if reasons.get(&rel) == Some(&RemovalReason::Requested) => format!("#{rel}, which related it to its {label} #{p}, was deleted"),
            None if reasons.get(&rel) == Some(&RemovalReason::Requested) => format!("#{rel}, which related it to its {label}, was deleted"),
            Some(p) => format!("#{rel}, which related it to its {label} #{p}, was removed because it referenced a deleted record"),
            None => format!("#{rel}, which related it to its {label}, was removed"),
        };
        let children = attrs.get(related_idx).and_then(|a| a.list.as_ref()).into_iter().flatten().flatten();
        for &child in children.filter(|c| !removed.contains(c)) {
            out.push(ValidationFinding {
                express_id: Some(child),
                message: format!("no longer in the spatial tree: {cause}"),
            });
        }
    }
    out
}
