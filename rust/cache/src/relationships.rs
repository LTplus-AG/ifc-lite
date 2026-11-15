// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The Relationships section (`sections/relationships.ts`): the
//! `RelationshipGraphBuilder` CSR, built from the data model's relationship
//! rows.
//!
//! Per direction (forward, then inverse):
//!   nodeCount u32, [entityId u32, offset u32, count u32] (ascending ids),
//!   edgeCount u32, edgeTargets u32[], edgeTypes u16[], edgeRelIds u32[],
//!   shadowedGroupCount u32, shadowedEdgeIndex u32[],
//!   shadowedGroupOffsets u32[groups + 1], shadowedIdCount u32,
//!   shadowedRelIds u32[]   (v18+)
//!
//! The edge kinds are `RelationshipType` (`packages/data`) via the parser's
//! `REL_TYPE_MAP` / `SECONDARY_REL_TYPE_MAP`. A class neither map names gets
//! no edge, exactly as the TS parser; so does the data model's synthetic
//! `TYPEHASPROPERTYSETS` row, which no `IfcRel*` instance declares.

use std::collections::{BTreeMap, HashMap};

use ifc_lite_processing::data_model::Relationship;

use crate::buf::Buf;

/// `REL_TYPE_MAP`: the primary edge kind of each STEP class.
fn primary_kind(upper: &str) -> Option<u16> {
    Some(match upper {
        "IFCRELCONTAINEDINSPATIALSTRUCTURE" => 1,
        "IFCRELAGGREGATES" | "IFCRELNESTS" => 2,
        "IFCRELPROJECTSELEMENT" => 4,
        "IFCRELADHERESTOELEMENT" => 5,
        "IFCRELDEFINESBYPROPERTIES" => 10,
        "IFCRELDEFINESBYTYPE" => 11,
        "IFCRELDEFINESBYOBJECT" => 12,
        "IFCRELDEFINESBYTEMPLATE" => 13,
        "IFCRELOVERRIDESPROPERTIES" => 14,
        "IFCRELASSOCIATESMATERIAL" => 20,
        "IFCRELASSOCIATESCLASSIFICATION" => 30,
        "IFCRELASSOCIATESDOCUMENT" => 31,
        "IFCRELASSOCIATESCONSTRAINT" => 32,
        "IFCRELASSOCIATESAPPROVAL" => 33,
        "IFCRELASSOCIATESLIBRARY" => 34,
        "IFCRELASSOCIATESAPPLIEDVALUE" => 35,
        "IFCRELASSOCIATESPROFILEDEF" => 36,
        "IFCRELASSOCIATESPROFILEPROPERTIES" => 37,
        "IFCRELCONNECTSPATHELEMENTS" => 40,
        "IFCRELFILLSELEMENT" => 41,
        "IFCRELVOIDSELEMENT" => 42,
        "IFCRELCONNECTSELEMENTS" => 43,
        "IFCRELCONNECTSPORTTOELEMENT" => 44,
        "IFCRELCONNECTSPORTS" => 45,
        "IFCRELINTERFERESELEMENTS" => 46,
        "IFCRELCOVERSBLDGELEMENTS" => 47,
        "IFCRELCOVERSSPACES" => 48,
        "IFCRELSERVICESBUILDINGS" => 49,
        "IFCRELSPACEBOUNDARY" => 50,
        "IFCRELCONNECTSSTRUCTURALACTIVITY" => 51,
        "IFCRELCONNECTSSTRUCTURALMEMBER" => 52,
        "IFCRELCONNECTSWITHECCENTRICITY" => 53,
        "IFCRELCONNECTSSTRUCTURALELEMENT" => 54,
        "IFCRELCONNECTSWITHREALIZINGELEMENTS" => 55,
        "IFCRELINTERACTIONREQUIREMENTS" => 56,
        "IFCRELSPACEBOUNDARY1STLEVEL" => 57,
        "IFCRELSPACEBOUNDARY2NDLEVEL" => 58,
        "IFCRELASSIGNSTOGROUP" | "IFCRELASSIGNSTOGROUPBYFACTOR" => 60,
        "IFCRELASSIGNSTOPRODUCT" => 61,
        "IFCRELASSIGNSTOACTOR" => 63,
        "IFCRELASSIGNSTORESOURCE" => 64,
        "IFCRELASSIGNSTOPROCESS" => 65,
        "IFCRELASSIGNSTOCONTROL" => 66,
        "IFCRELASSIGNSTASKS" => 67,
        "IFCRELASSIGNSTOPROJECTORDER" => 68,
        "IFCRELSCHEDULESCOSTITEMS" => 69,
        "IFCRELREFERENCEDINSPATIALSTRUCTURE" => 70,
        "IFCRELOCCUPIESSPACES" => 71,
        "IFCRELDECLARES" => 80,
        "IFCRELPOSITIONS" => 90,
        "IFCRELFLOWCONTROLELEMENTS" => 91,
        "IFCRELSEQUENCE" => 92,
        _ => return None,
    })
}

/// `SECONDARY_REL_TYPE_MAP`: the precise kind recorded beside the folded
/// primary bucket (#4205).
fn secondary_kind(upper: &str) -> Option<u16> {
    match upper {
        "IFCRELNESTS" => Some(3),
        "IFCRELASSIGNSTOGROUPBYFACTOR" => Some(62),
        _ => None,
    }
}

/// `RelationshipGraphBuilder`: edges in insertion order, a repeated
/// `(source, target, kind)` folded into the surviving edge's shadow list.
#[derive(Default)]
struct GraphBuilder {
    sources: Vec<u32>,
    targets: Vec<u32>,
    kinds: Vec<u16>,
    rel_ids: Vec<u32>,
    seen: HashMap<(u32, u32, u16), usize>,
    shadowed: HashMap<usize, Vec<u32>>,
}

impl GraphBuilder {
    fn add_edge(&mut self, source: u32, target: u32, kind: u16, rel_id: u32) {
        if let Some(&existing) = self.seen.get(&(source, target, kind)) {
            self.shadowed.entry(existing).or_default().push(rel_id);
            return;
        }
        self.seen.insert((source, target, kind), self.sources.len());
        self.sources.push(source);
        self.targets.push(target);
        self.kinds.push(kind);
        self.rel_ids.push(rel_id);
    }
}

/// Edges in the order the TS parser adds them: per `IfcRel*` instance, every
/// primary edge, then every secondary one. The data model emits one row per
/// (relating, related) pair, consecutive per instance.
pub(crate) fn write_relationships(relationships: &[Relationship]) -> Vec<u8> {
    let mut builder = GraphBuilder::default();
    let mut at = 0;
    while at < relationships.len() {
        let rel_id = relationships[at].rel_id;
        let mut end = at + 1;
        while end < relationships.len() && relationships[end].rel_id == rel_id {
            end += 1;
        }
        let group = &relationships[at..end];
        let upper = group[0].rel_type.to_ascii_uppercase();
        for kind in [primary_kind(&upper), secondary_kind(&upper)].into_iter().flatten() {
            for row in group {
                builder.add_edge(row.relating_id, row.related_id, kind, row.rel_id);
            }
        }
        at = end;
    }
    let mut buf = Buf::new();
    write_direction(&mut buf, &builder, &builder.sources, &builder.targets);
    write_direction(&mut buf, &builder, &builder.targets, &builder.sources);
    buf.into_vec()
}

/// `buildCSR` + `writeEdges` for one direction.
fn write_direction(buf: &mut Buf, graph: &GraphBuilder, keys: &[u32], values: &[u32]) {
    let mut counts: BTreeMap<u32, u32> = BTreeMap::new();
    for key in keys {
        *counts.entry(*key).or_default() += 1;
    }
    let mut offsets: BTreeMap<u32, u32> = BTreeMap::new();
    let mut running = 0;
    for (key, count) in &counts {
        offsets.insert(*key, running);
        running += count;
    }
    buf.u32(counts.len() as u32);
    for (key, count) in &counts {
        buf.u32(*key);
        buf.u32(offsets[key]);
        buf.u32(*count);
    }

    let n = keys.len();
    let mut targets = vec![0u32; n];
    let mut kinds = vec![0u16; n];
    let mut rel_ids = vec![0u32; n];
    let mut shadowed: Vec<(u32, &[u32])> = Vec::new();
    let mut cursor = offsets.clone();
    for edge in 0..n {
        let slot = cursor.get_mut(&keys[edge]).expect("every key was counted");
        let position = *slot as usize;
        targets[position] = values[edge];
        kinds[position] = graph.kinds[edge];
        rel_ids[position] = graph.rel_ids[edge];
        if let Some(ids) = graph.shadowed.get(&edge).filter(|ids| !ids.is_empty()) {
            shadowed.push((position as u32, ids));
        }
        *slot += 1;
    }
    buf.u32(n as u32);
    buf.u32s(&targets);
    for kind in kinds {
        buf.u16(kind);
    }
    buf.u32s(&rel_ids);

    // `buildShadowedColumns`: groups sorted by final edge position.
    shadowed.sort_by_key(|(position, _)| *position);
    buf.u32(shadowed.len() as u32);
    for (position, _) in &shadowed {
        buf.u32(*position);
    }
    let mut cursor = 0u32;
    for (_, ids) in &shadowed {
        buf.u32(cursor);
        cursor += ids.len() as u32;
    }
    buf.u32(cursor);
    buf.u32(cursor);
    for (_, ids) in &shadowed {
        buf.u32s(ids);
    }
}

#[cfg(test)]
#[path = "relationships_tests.rs"]
mod tests;
