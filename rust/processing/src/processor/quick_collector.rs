// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The quick-metadata bootstrap's scan-time state (`Features::quick_metadata_bootstrap`).
//!
//! [`QuickCollector`] sees every record the scan loop reads, keeps the spatial
//! containers and the three kinds of spatial relationship, and turns them into
//! a [`QuickMetadataBootstrap`] once the unit scale is known. The tree-building
//! rules themselves live in `quick_metadata.rs`.

use super::quick_metadata::{
    build_quick_spatial_tree_node, extract_name_from_args, is_quick_spatial_type_ci,
    parse_step_arguments, parse_step_ref, parse_step_ref_list, read_storey_elevation,
    QuickSpatialNodeEntry,
};
use crate::types::response::{QuickMetadataBootstrap, QuickMetadataEntitySummary};
use ifc_lite_core::keyword_eq;
use std::collections::HashMap;

/// Collects the bootstrap's inputs during the entity scan.
pub(super) struct QuickCollector {
    nodes: HashMap<u32, QuickSpatialNodeEntry>,
    /// `IfcRelAggregates`: `(parent, children)`.
    aggregate_links: Vec<(u32, Vec<u32>)>,
    /// `IfcRelContainedInSpatialStructure`: `(structure, contained)`.
    containment_links: Vec<(u32, Vec<u32>)>,
    // IfcRelReferencedInSpatialStructure is a *secondary* (non-owning) link — a
    // space referenced from another storey for context. It must NOT establish
    // primary tree ownership, so it is kept separate from containment links and
    // only ever contributes elements, never parent/child node ownership (#1075).
    referenced_links: Vec<(u32, Vec<u32>)>,
    element_summaries: HashMap<u32, QuickMetadataEntitySummary>,
}

impl QuickCollector {
    pub(super) fn new() -> Self {
        Self {
            nodes: HashMap::new(),
            aggregate_links: Vec::new(),
            containment_links: Vec::new(),
            referenced_links: Vec::new(),
            element_summaries: HashMap::new(),
        }
    }

    /// One scanned record: a spatial container becomes a node, a spatial
    /// relationship becomes a link; anything else is ignored.
    pub(super) fn observe(&mut self, content: &[u8], id: u32, type_name: &str, start: usize, end: usize) {
        // Case-insensitive check without allocating a new uppercase string.
        if is_quick_spatial_type_ci(type_name) {
            let args = parse_step_arguments(&content[start..end]);
            let fallback = format!("{type_name} #{id}");
            self.nodes.entry(id).or_insert(QuickSpatialNodeEntry {
                express_id: id,
                type_name: type_name.to_string(),
                name: extract_name_from_args(&args, &fallback),
                elevation: None,
                raw_elevation: keyword_eq(type_name, "IFCBUILDINGSTOREY").then(|| read_storey_elevation(&args)),
                children: Vec::new(),
                contained: Vec::new(),
                elements: Vec::new(),
                named_as_child: false,
            });
        } else if keyword_eq(type_name, "IFCRELAGGREGATES") {
            let args = parse_step_arguments(&content[start..end]);
            if let Some(parent_id) = args.get(4).and_then(|token| parse_step_ref(token)) {
                self.aggregate_links.push((
                    parent_id,
                    args.get(5)
                        .map(|token| parse_step_ref_list(token))
                        .unwrap_or_default(),
                ));
            }
        } else if keyword_eq(type_name, "IFCRELCONTAINEDINSPATIALSTRUCTURE") {
            let args = parse_step_arguments(&content[start..end]);
            if let Some(parent_id) = args.get(5).and_then(|token| parse_step_ref(token)) {
                self.containment_links.push((
                    parent_id,
                    args.get(4)
                        .map(|token| parse_step_ref_list(token))
                        .unwrap_or_default(),
                ));
            }
        } else if keyword_eq(type_name, "IFCRELREFERENCEDINSPATIALSTRUCTURE") {
            let args = parse_step_arguments(&content[start..end]);
            if let Some(parent_id) = args.get(5).and_then(|token| parse_step_ref(token)) {
                self.referenced_links.push((
                    parent_id,
                    args.get(4)
                        .map(|token| parse_step_ref_list(token))
                        .unwrap_or_default(),
                ));
            }
        }
    }

    /// A geometry-bearing product was scheduled: it is an element row in the tree.
    pub(super) fn note_element(&mut self, id: u32, type_name: &str) {
        self.element_summaries.insert(
            id,
            QuickMetadataEntitySummary {
                express_id: id,
                type_name: type_name.to_string(),
                name: format!("{type_name} #{id}"),
                global_id: None,
                kind: "element".to_string(),
                has_children: false,
                element_count: None,
                elevation: None,
            },
        );
    }

    /// Resolve the links against the nodes and build the bootstrap.
    pub(super) fn finish(
        self,
        length_unit_scale: f64,
        schema_version: &str,
        entity_count: usize,
    ) -> QuickMetadataBootstrap {
        let Self {
            nodes: mut spatial_nodes,
            aggregate_links: quick_aggregate_links,
            containment_links: quick_containment_links,
            referenced_links: quick_referenced_links,
            element_summaries: quick_element_summaries,
        } = self;
        // A refused unit has no metre scale; its elevation stays in file units.
        spatial_nodes.values_mut().for_each(|n| n.finish_elevation(length_unit_scale));
        for (parent_id, child_ids) in quick_aggregate_links {
            if !spatial_nodes.contains_key(&parent_id) {
                continue;
            }
            for child_id in child_ids {
                if !spatial_nodes.contains_key(&child_id) {
                    continue;
                }
                if let Some(parent) = spatial_nodes.get_mut(&parent_id) {
                    parent.children.push(child_id);
                }
                if let Some(child) = spatial_nodes.get_mut(&child_id) {
                    child.named_as_child = true;
                }
            }
        }
        for (parent_id, element_ids) in quick_containment_links {
            if !spatial_nodes.contains_key(&parent_id) {
                continue;
            }
            for child_id in element_ids {
                // A spatial element (IfcSpace / IfcSpatialZone) attached to a
                // storey via IfcRelContainedInSpatialStructure — what Revit
                // Family + Dynamo emits instead of IfcRelAggregates — is a real
                // node of the spatial tree, not a contained product. Promote it
                // to a child node so it shows in the hierarchy (#1075); anything
                // that isn't itself a spatial node stays a contained element.
                //
                // Recorded even when an aggregate also names the child: whether
                // that aggregate's parent is reachable from the root is not
                // known here, and an edge from an orphan or from the child's
                // own descendant must not take the space out of the tree
                // (#4689). `ContainmentPlan` lets a settled aggregate win.
                if spatial_nodes.contains_key(&child_id) {
                    if let Some(parent) = spatial_nodes.get_mut(&parent_id) {
                        parent.contained.push(child_id);
                    }
                    if let Some(child) = spatial_nodes.get_mut(&child_id) {
                        child.named_as_child = true;
                    }
                } else if let Some(parent) = spatial_nodes.get_mut(&parent_id) {
                    parent.elements.push(child_id);
                }
            }
        }
        // Referenced-in links are non-owning: they only contribute elements and
        // never promote to (or re-parent) a spatial node, so a space referenced
        // from a second storey can't steal ownership from its containing storey.
        for (parent_id, element_ids) in quick_referenced_links {
            if !spatial_nodes.contains_key(&parent_id) {
                continue;
            }
            for child_id in element_ids {
                // A child that is itself a spatial node keeps the ownership it
                // got from its IfcRelContainedInSpatialStructure/aggregate link.
                if spatial_nodes.contains_key(&child_id) {
                    continue;
                }
                if let Some(parent) = spatial_nodes.get_mut(&parent_id) {
                    parent.elements.push(child_id);
                }
            }
        }
        // `type_name` is the raw keyword; `min` rather than `find` because
        // `spatial_nodes` is a HashMap, so a file with two roots (or no
        // IfcProject) would otherwise pick a different tree per run.
        let root_id = spatial_nodes
            .values()
            .filter(|node| keyword_eq(&node.type_name, "IFCPROJECT"))
            .map(|node| node.express_id)
            .min()
            .or_else(|| {
                // Prefer a node no edge names as a child, but when every node
                // is one (a back-edge to the top node) still build from the
                // lowest id rather than emit no tree (#4689).
                spatial_nodes
                    .values()
                    .min_by_key(|node| (node.named_as_child, node.express_id))
                    .map(|node| node.express_id)
            });
        let (spatial_tree, pruned_aggregate_edges) = root_id
            .and_then(|root| {
                build_quick_spatial_tree_node(root, &spatial_nodes, &quick_element_summaries).ok()
            })
            .unzip();
        QuickMetadataBootstrap {
            schema_version: schema_version.to_string(),
            entity_count,
            spatial_tree,
            pruned_aggregate_edges: pruned_aggregate_edges.unwrap_or_default(),
        }
    }
}
