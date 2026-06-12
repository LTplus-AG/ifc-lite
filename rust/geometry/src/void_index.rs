// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Void Index Module
//!
//! Builds and manages the mapping between host elements (walls, slabs, etc.)
//! and their associated voids (openings, penetrations).
//!
//! In IFC, voids are related to their host elements via `IfcRelVoidsElement`:
//! - RelatingBuildingElement: The host (wall, slab, beam, etc.)
//! - RelatedOpeningElement: The opening (IfcOpeningElement)

use ifc_lite_core::{EntityDecoder, EntityScanner, IfcType};
use rustc_hash::{FxHashMap, FxHashSet};

/// Propagate openings from hosts that aggregate parts to every aggregated
/// descendant — recursive and type-agnostic (IfcWallElementedCase panels,
/// IfcRoof → IfcSlab skylights, nested assemblies, …).
///
/// The IFC4 spec allows an opening on a host whose geometry is distributed
/// across aggregated parts; without propagation the cut runs against an empty
/// host mesh and produces a "silent no-op" while the parts cover what should
/// be the window/door hole.
///
/// Single shared kernel for all three pipelines (server `process_geometry`,
/// wasm `buildPrePassOnce`, wasm `buildPrePassStreaming`) so they cannot
/// drift on which descendants receive the cut.
///
/// Propagation is breadth-first with a visited-set cycle guard. Existing
/// void entries for a part are extended (deduplicated) so an authored direct
/// void is never overwritten.
pub fn propagate_voids_via_aggregates(
    void_index: &mut FxHashMap<u32, Vec<u32>>,
    aggregate_children: &FxHashMap<u32, Vec<u32>>,
) {
    if void_index.is_empty() || aggregate_children.is_empty() {
        return;
    }

    // Snapshot host ids first — we mutate void_index inside the loop.
    let hosts: Vec<u32> = void_index.keys().copied().collect();

    for host in hosts {
        let openings = match void_index.get(&host) {
            Some(list) if !list.is_empty() => list.clone(),
            _ => continue,
        };

        // BFS over aggregated descendants of `host`. Skip the host itself.
        let mut stack: Vec<u32> = match aggregate_children.get(&host) {
            Some(kids) => kids.clone(),
            None => continue,
        };
        let mut seen: FxHashSet<u32> = FxHashSet::default();
        seen.insert(host);

        while let Some(part) = stack.pop() {
            if !seen.insert(part) {
                continue;
            }

            // Mirror the openings onto this part, deduplicated.
            let entry = void_index.entry(part).or_default();
            for opening in &openings {
                if !entry.contains(opening) {
                    entry.push(*opening);
                }
            }

            if let Some(grand_kids) = aggregate_children.get(&part) {
                for kid in grand_kids {
                    if !seen.contains(kid) {
                        stack.push(*kid);
                    }
                }
            }
        }
    }
}

/// Scan `content` for `IfcRelAggregates` and build the full (unfiltered)
/// parent → children map used by [`propagate_voids_via_aggregates`].
pub fn build_aggregate_children_index(
    content: &str,
    decoder: &mut EntityDecoder,
) -> FxHashMap<u32, Vec<u32>> {
    let mut scanner = EntityScanner::new(content);
    let mut aggregate_children: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name != "IFCRELAGGREGATES" {
            continue;
        }
        let entity = match decoder.decode_at_with_id(id, start, end) {
            Ok(e) => e,
            Err(_) => continue,
        };
        // IfcRelAggregates: attr 4 = RelatingObject, attr 5 = RelatedObjects
        let parent_id = match entity.get_ref(4) {
            Some(id) => id,
            None => continue,
        };
        let children: Vec<u32> = match entity.get(5).and_then(|a| a.as_list()) {
            Some(list) => list
                .iter()
                .filter_map(|item| item.as_entity_ref())
                .collect(),
            None => continue,
        };
        if !children.is_empty() {
            aggregate_children
                .entry(parent_id)
                .or_default()
                .extend(children);
        }
    }
    aggregate_children
}

/// Propagate void (opening) relationships from aggregate parents to their children
/// and return a child-part → parent-element map covering every emitted aggregate
/// `IfcWall` → `IfcBuildingElementPart` pair.
///
/// In IFC, multilayer walls use `IfcRelAggregates` to decompose a parent `IfcWall`
/// into child `IfcBuildingElementPart` entities (one per material layer). The
/// `IfcRelVoidsElement` relationships reference the parent wall, but the individual
/// layer parts also need void subtraction to cut windows/doors through each layer.
///
/// This function scans for `IfcRelAggregates` and, in the same pass:
///
/// 1. Copies parent-wall void relationships to every child part that has a
///    `Representation` so each layer slice still gets window/door cutouts.
/// 2. Returns a [`FxHashMap`] mapping every emitted child `IfcBuildingElementPart`
///    id to its parent element id. Callers use this to skip per-part geometry
///    emission when the "merge multilayer wall as a single solid" toggle is on
///    (issue #540) — but **only** for parents that have their own
///    `Representation` attribute set (otherwise the parent has no fallback
///    geometry and the layer parts must be kept).
///
/// The map only contains children whose parent has a non-null `Representation`
/// (attribute index 6 on `IfcProduct`); parents without their own geometry are
/// left out of the returned map so the caller can never "skip" the only
/// geometry available for the assembly.
#[must_use = "the returned part → parent map is needed to honour the merge-layers toggle"]
pub fn propagate_voids_to_parts(
    void_index: &mut FxHashMap<u32, Vec<u32>>,
    content: &str,
    decoder: &mut EntityDecoder,
) -> FxHashMap<u32, u32> {
    let aggregate_children = build_aggregate_children_index(content, decoder);

    // Void propagation: recursive + type-agnostic over the FULL aggregate
    // tree (shared kernel — same behaviour as the server pipeline). The
    // BEP/representation filters below apply only to the part → parent map.
    propagate_voids_via_aggregates(void_index, &aggregate_children);

    // part → parent map: restricted to IfcBuildingElementPart children with
    // their own Representation, under parents that also have one (otherwise
    // the caller could "skip" the only geometry available for the assembly).
    let mut part_to_parent: FxHashMap<u32, u32> = FxHashMap::default();
    for (&parent_id, children) in &aggregate_children {
        let parent_has_repr = decoder
            .decode_by_id(parent_id)
            .map(|p| p.get(6).map(|a| !a.is_null()).unwrap_or(false))
            .unwrap_or(false);
        if !parent_has_repr {
            continue;
        }
        for &child_id in children {
            if let Ok(child) = decoder.decode_by_id(child_id) {
                if child.ifc_type == IfcType::IfcBuildingElementPart {
                    let has_repr = child.get(6).map(|a| !a.is_null()).unwrap_or(false);
                    if has_repr {
                        part_to_parent.insert(child_id, parent_id);
                    }
                }
            }
        }
    }

    part_to_parent
}

/// Compute the set of aggregated `IfcBuildingElementPart` ids to skip when the
/// "merge multilayer wall as a single solid" toggle is on (issue #540): a part
/// is skipped when its parent's layered build-up is *sliceable*, so the parent's
/// merged-layer geometry is drawn instead of the individual parts.
///
/// This is the layer/void **driver** — it composes the two shared geometry
/// kernels ([`propagate_voids_to_parts`] for part→parent + void propagation, and
/// [`MaterialLayerIndex::is_sliceable`]) so the driver lives in the geometry
/// crate next to its kernels rather than inline in a consumer (#913 Phase 4 /
/// §2.6). The browser's `merge_layers` path calls it; a `void_index` scratch map
/// is filled and discarded (callers that also need the propagated voids should
/// call [`propagate_voids_to_parts`] directly with their own `void_index`).
#[must_use]
pub fn compute_parts_to_skip(
    content: &str,
    decoder: &mut EntityDecoder,
) -> rustc_hash::FxHashSet<u32> {
    let material_layer_index = crate::MaterialLayerIndex::from_content(content, decoder);
    let mut void_index_scratch: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let part_to_parent = propagate_voids_to_parts(&mut void_index_scratch, content, decoder);
    part_to_parent
        .into_iter()
        .filter(|(_, parent_id)| material_layer_index.is_sliceable(*parent_id))
        .map(|(part_id, _)| part_id)
        .collect()
}

/// Index mapping host elements to their voids
///
/// Provides efficient lookup of void entity IDs for any host element,
/// enabling void-aware geometry processing.
#[derive(Debug, Clone)]
pub struct VoidIndex {
    /// Map from host entity ID to list of void entity IDs
    host_to_voids: FxHashMap<u32, Vec<u32>>,
    /// Map from void entity ID to host entity ID (reverse lookup)
    void_to_host: FxHashMap<u32, u32>,
    /// Total number of void relationships
    relationship_count: usize,
}

impl VoidIndex {
    /// Create an empty void index
    pub fn new() -> Self {
        Self {
            host_to_voids: FxHashMap::default(),
            void_to_host: FxHashMap::default(),
            relationship_count: 0,
        }
    }

    /// Build void index from IFC content
    ///
    /// Scans the content for `IfcRelVoidsElement` entities and builds
    /// the host-to-void mapping.
    ///
    /// # Arguments
    /// * `content` - The raw IFC file content
    /// * `decoder` - Entity decoder for parsing
    ///
    /// # Returns
    /// A populated VoidIndex
    pub fn from_content(content: &str, decoder: &mut EntityDecoder) -> Self {
        let mut index = Self::new();
        let mut scanner = EntityScanner::new(content);

        while let Some((_id, type_name, start, end)) = scanner.next_entity() {
            // Look for IfcRelVoidsElement relationships
            if type_name == "IFCRELVOIDSELEMENT" {
                if let Ok(entity) = decoder.decode_at(start, end) {
                    // IfcRelVoidsElement structure:
                    // #id = IFCRELVOIDSELEMENT(GlobalId, OwnerHistory, Name, Description,
                    //                          RelatingBuildingElement, RelatedOpeningElement);
                    // Indices: 0=GlobalId, 1=OwnerHistory, 2=Name, 3=Description,
                    //          4=RelatingBuildingElement, 5=RelatedOpeningElement

                    if let (Some(host_id), Some(void_id)) = (entity.get_ref(4), entity.get_ref(5)) {
                        index.add_relationship(host_id, void_id);
                    }
                }
            }
        }

        index
    }

    /// Add a void relationship
    pub fn add_relationship(&mut self, host_id: u32, void_id: u32) {
        self.host_to_voids.entry(host_id).or_default().push(void_id);
        self.void_to_host.insert(void_id, host_id);
        self.relationship_count += 1;
    }

    /// Get void IDs for a host element
    ///
    /// # Arguments
    /// * `host_id` - The entity ID of the host element
    ///
    /// # Returns
    /// Slice of void entity IDs, or empty slice if no voids
    pub fn get_voids(&self, host_id: u32) -> &[u32] {
        self.host_to_voids
            .get(&host_id)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    /// Get the host ID for a void element
    ///
    /// # Arguments
    /// * `void_id` - The entity ID of the void/opening
    ///
    /// # Returns
    /// The host entity ID, if found
    pub fn get_host(&self, void_id: u32) -> Option<u32> {
        self.void_to_host.get(&void_id).copied()
    }

    /// Check if an element has any voids
    pub fn has_voids(&self, host_id: u32) -> bool {
        self.host_to_voids
            .get(&host_id)
            .map(|v| !v.is_empty())
            .unwrap_or(false)
    }

    /// Get number of voids for a host element
    pub fn void_count(&self, host_id: u32) -> usize {
        self.host_to_voids
            .get(&host_id)
            .map(|v| v.len())
            .unwrap_or(0)
    }

    /// Get total number of host elements with voids
    pub fn host_count(&self) -> usize {
        self.host_to_voids.len()
    }

    /// Get total number of void relationships
    pub fn total_relationships(&self) -> usize {
        self.relationship_count
    }

    /// Iterate over all host elements and their voids
    pub fn iter(&self) -> impl Iterator<Item = (u32, &[u32])> {
        self.host_to_voids.iter().map(|(k, v)| (*k, v.as_slice()))
    }

    /// Get all host IDs that have voids
    pub fn hosts_with_voids(&self) -> Vec<u32> {
        self.host_to_voids.keys().copied().collect()
    }

    /// Check if an entity is a void/opening
    pub fn is_void(&self, entity_id: u32) -> bool {
        self.void_to_host.contains_key(&entity_id)
    }

    /// Check if an entity is a host with voids
    pub fn is_host_with_voids(&self, entity_id: u32) -> bool {
        self.host_to_voids.contains_key(&entity_id)
    }
}

impl Default for VoidIndex {
    fn default() -> Self {
        Self::new()
    }
}

/// Statistics about void distribution in a model
#[derive(Debug, Clone)]
pub struct VoidStatistics {
    /// Total number of hosts with voids
    pub hosts_with_voids: usize,
    /// Total number of void relationships
    pub total_voids: usize,
    /// Maximum voids on a single host
    pub max_voids_per_host: usize,
    /// Average voids per host (that has voids)
    pub avg_voids_per_host: f64,
    /// Number of hosts with many voids (>10)
    pub hosts_with_many_voids: usize,
}

impl VoidStatistics {
    /// Compute statistics from a void index
    pub fn from_index(index: &VoidIndex) -> Self {
        let hosts_with_voids = index.host_count();
        let total_voids = index.total_relationships();

        let max_voids_per_host = index
            .host_to_voids
            .values()
            .map(|v| v.len())
            .max()
            .unwrap_or(0);

        let avg_voids_per_host = if hosts_with_voids > 0 {
            total_voids as f64 / hosts_with_voids as f64
        } else {
            0.0
        };

        let hosts_with_many_voids = index
            .host_to_voids
            .values()
            .filter(|v| v.len() > 10)
            .count();

        Self {
            hosts_with_voids,
            total_voids,
            max_voids_per_host,
            avg_voids_per_host,
            hosts_with_many_voids,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_void_index_basic() {
        let mut index = VoidIndex::new();

        // Add some relationships
        index.add_relationship(100, 200);
        index.add_relationship(100, 201);
        index.add_relationship(101, 202);

        // Test lookups
        assert_eq!(index.get_voids(100), &[200, 201]);
        assert_eq!(index.get_voids(101), &[202]);
        assert!(index.get_voids(999).is_empty());

        // Test reverse lookup
        assert_eq!(index.get_host(200), Some(100));
        assert_eq!(index.get_host(202), Some(101));
        assert_eq!(index.get_host(999), None);

        // Test counts
        assert_eq!(index.void_count(100), 2);
        assert_eq!(index.void_count(101), 1);
        assert_eq!(index.host_count(), 2);
        assert_eq!(index.total_relationships(), 3);
    }

    #[test]
    fn test_void_index_has_voids() {
        let mut index = VoidIndex::new();
        index.add_relationship(100, 200);

        assert!(index.has_voids(100));
        assert!(!index.has_voids(999));
    }

    #[test]
    fn test_void_index_is_void() {
        let mut index = VoidIndex::new();
        index.add_relationship(100, 200);

        assert!(index.is_void(200));
        assert!(!index.is_void(100));
        assert!(!index.is_void(999));
    }

    #[test]
    fn test_void_index_hosts_with_voids() {
        let mut index = VoidIndex::new();
        index.add_relationship(100, 200);
        index.add_relationship(101, 201);
        index.add_relationship(102, 202);

        let hosts = index.hosts_with_voids();
        assert_eq!(hosts.len(), 3);
        assert!(hosts.contains(&100));
        assert!(hosts.contains(&101));
        assert!(hosts.contains(&102));
    }

    #[test]
    fn test_void_statistics() {
        let mut index = VoidIndex::new();

        // Host 100 has 3 voids
        index.add_relationship(100, 200);
        index.add_relationship(100, 201);
        index.add_relationship(100, 202);

        // Host 101 has 1 void
        index.add_relationship(101, 203);

        let stats = VoidStatistics::from_index(&index);

        assert_eq!(stats.hosts_with_voids, 2);
        assert_eq!(stats.total_voids, 4);
        assert_eq!(stats.max_voids_per_host, 3);
        assert!((stats.avg_voids_per_host - 2.0).abs() < 0.01);
        assert_eq!(stats.hosts_with_many_voids, 0);
    }

    #[test]
    fn test_void_statistics_many_voids() {
        let mut index = VoidIndex::new();

        // Host 100 has 15 voids (> 10 threshold)
        for i in 0..15 {
            index.add_relationship(100, 200 + i);
        }

        let stats = VoidStatistics::from_index(&index);
        assert_eq!(stats.hosts_with_many_voids, 1);
    }

    // ── propagate_voids_to_parts ─────────────────────────────────────────
    //
    // The synthetic IFC strings below are deliberately minimal — they
    // only carry the entities `propagate_voids_to_parts` actually looks
    // at (`IFCRELAGGREGATES`, the parent `IFCWALL`/`IFCBUILDINGELEMENTPART`
    // entries, and an `IFCRELVOIDSELEMENT` for the parent). The geometry
    // attributes don't matter to the index — only that the parent and
    // the parts carry a non-null `Representation`.

    use ifc_lite_core::EntityDecoder;

    /// Three-layer wall with one window opening and a parent representation.
    /// All three parts and the parent each carry a `#51` representation ref so
    /// every emitted child appears in the returned part→parent map.
    fn three_layer_wall_with_voids_ifc() -> String {
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#50=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#40));
#40=IFCEXTRUDEDAREASOLID($,$,$,3.0);
#100=IFCWALL('0001wall',$,'Parent',$,$,$,#51,$,$);
#101=IFCBUILDINGELEMENTPART('0001p01',$,'L0',$,$,$,#51,$,$);
#102=IFCBUILDINGELEMENTPART('0001p02',$,'L1',$,$,$,#51,$,$);
#103=IFCBUILDINGELEMENTPART('0001p03',$,'L2',$,$,$,#51,$,$);
#200=IFCOPENINGELEMENT('0001op',$,'Opening',$,$,$,#51,$,$);
#210=IFCRELVOIDSELEMENT('0001rv',$,$,$,#100,#200);
#300=IFCRELAGGREGATES('0001ra',$,$,$,#100,(#101,#102,#103));
ENDSEC;
END-ISO-10303-21;
"#
        .to_string()
    }

    /// Aggregate where the parent wall has NO representation (null `#51`).
    /// The parts ARE the only geometry — the map must NOT contain them.
    fn parts_only_aggregate_ifc() -> String {
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#50=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#40));
#40=IFCEXTRUDEDAREASOLID($,$,$,3.0);
#100=IFCWALL('0001wall',$,'Parent',$,$,$,$,$,$);
#101=IFCBUILDINGELEMENTPART('0001p01',$,'L0',$,$,$,#51,$,$);
#102=IFCBUILDINGELEMENTPART('0001p02',$,'L1',$,$,$,#51,$,$);
#103=IFCBUILDINGELEMENTPART('0001p03',$,'L2',$,$,$,#51,$,$);
#300=IFCRELAGGREGATES('0001ra',$,$,$,#100,(#101,#102,#103));
ENDSEC;
END-ISO-10303-21;
"#
        .to_string()
    }

    #[test]
    fn propagate_voids_returns_part_to_parent_map() {
        let content = three_layer_wall_with_voids_ifc();
        let mut decoder = EntityDecoder::new(&content);

        // Seed the index with the parent's voids (caller normally does this
        // from the IFCRELVOIDSELEMENT pre-scan).
        let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
        void_index.insert(100, vec![200]);

        let part_to_parent = propagate_voids_to_parts(&mut void_index, &content, &mut decoder);

        // Three parts, all mapped to the same parent.
        assert_eq!(part_to_parent.len(), 3);
        assert_eq!(part_to_parent.get(&101).copied(), Some(100));
        assert_eq!(part_to_parent.get(&102).copied(), Some(100));
        assert_eq!(part_to_parent.get(&103).copied(), Some(100));

        // Voids were propagated to every child.
        assert_eq!(void_index.get(&101).map(Vec::as_slice), Some(&[200u32][..]));
        assert_eq!(void_index.get(&102).map(Vec::as_slice), Some(&[200u32][..]));
        assert_eq!(void_index.get(&103).map(Vec::as_slice), Some(&[200u32][..]));
    }

    #[test]
    fn propagate_voids_skips_parents_without_representation() {
        let content = parts_only_aggregate_ifc();
        let mut decoder = EntityDecoder::new(&content);

        // No voids on the parent for this case — we only care about the map.
        let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();

        let part_to_parent = propagate_voids_to_parts(&mut void_index, &content, &mut decoder);

        // Parent #100 has null Representation, so the parts are the only
        // geometry — none of them should appear in the skip-eligible map.
        assert!(
            part_to_parent.is_empty(),
            "expected empty map when parent has no representation, got {:?}",
            part_to_parent
        );
    }

    #[test]
    fn propagate_voids_returns_empty_map_when_no_aggregates() {
        let empty = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('0001w',$,'L',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
"#
        .to_string();
        let mut decoder = EntityDecoder::new(&empty);
        let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
        let part_to_parent = propagate_voids_to_parts(&mut void_index, &empty, &mut decoder);
        assert!(part_to_parent.is_empty());
        assert!(void_index.is_empty());
    }

    // ── propagate_voids_via_aggregates (shared BFS kernel) ───────────────

    fn agg_map(pairs: &[(u32, &[u32])]) -> FxHashMap<u32, Vec<u32>> {
        pairs.iter().map(|(k, v)| (*k, v.to_vec())).collect()
    }

    #[test]
    fn propagate_voids_walks_full_aggregate_tree() {
        // Host #100 voided by openings #200 and #201. The host aggregates
        // parts #110 and #111; #110 further aggregates #120 (a grand-part).
        // Every leaf in the aggregate sub-tree must inherit both openings.
        let mut void_index = agg_map(&[(100, &[200, 201])]);
        let aggregate_children = agg_map(&[(100, &[110, 111]), (110, &[120])]);

        propagate_voids_via_aggregates(&mut void_index, &aggregate_children);

        let expected = [200, 201];
        for part in &[110, 111, 120] {
            let got = void_index.get(part).expect("part should have voids");
            assert_eq!(
                got.iter().copied().collect::<std::collections::HashSet<_>>(),
                expected.iter().copied().collect::<std::collections::HashSet<_>>(),
                "part #{part} should receive both openings",
            );
        }
        // Host entry is preserved untouched.
        assert_eq!(void_index.get(&100), Some(&vec![200, 201]));
    }

    #[test]
    fn propagate_voids_deduplicates_existing_part_voids() {
        // Authored: part #110 already voided by opening #999 directly.
        // After propagation it must have #200 and #999, not #200 twice.
        let mut void_index = agg_map(&[(100, &[200]), (110, &[999])]);
        let aggregate_children = agg_map(&[(100, &[110])]);

        propagate_voids_via_aggregates(&mut void_index, &aggregate_children);

        let mut part_voids = void_index.get(&110).unwrap().clone();
        part_voids.sort();
        assert_eq!(part_voids, vec![200, 999]);
    }

    #[test]
    fn propagate_voids_handles_aggregate_cycles() {
        // Cyclic IfcRelAggregates: #110 -> #120 -> #110. Without the visited
        // guard this loops forever. With it the walk terminates and both
        // parts get the openings exactly once.
        let mut void_index = agg_map(&[(100, &[200])]);
        let aggregate_children = agg_map(&[(100, &[110]), (110, &[120]), (120, &[110])]);

        propagate_voids_via_aggregates(&mut void_index, &aggregate_children);

        assert_eq!(void_index.get(&110), Some(&vec![200]));
        assert_eq!(void_index.get(&120), Some(&vec![200]));
    }

    #[test]
    fn propagate_voids_no_op_when_host_has_no_parts() {
        let mut void_index = agg_map(&[(100, &[200])]);
        let aggregate_children = agg_map(&[(101, &[110])]); // different host
        let before = void_index.clone();

        propagate_voids_via_aggregates(&mut void_index, &aggregate_children);

        assert_eq!(void_index, before);
    }

    #[test]
    fn propagate_voids_to_parts_covers_non_bep_descendants() {
        // Parity with the server pipeline: an IfcRoof aggregating an IfcSlab
        // (skylight pattern) must propagate the roof's opening to the slab
        // even though the child is not an IfcBuildingElementPart.
        let content = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#50=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#40));
#40=IFCEXTRUDEDAREASOLID($,$,$,3.0);
#100=IFCROOF('0001roof',$,'Roof',$,$,$,$,$,$);
#101=IFCSLAB('0001slab',$,'Pitch',$,$,$,#51,$,$);
#200=IFCOPENINGELEMENT('0001op',$,'Skylight',$,$,$,#51,$,$);
#210=IFCRELVOIDSELEMENT('0001rv',$,$,$,#100,#200);
#300=IFCRELAGGREGATES('0001ra',$,$,$,#100,(#101));
ENDSEC;
END-ISO-10303-21;
"#;
        let mut decoder = EntityDecoder::new(content);
        let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
        void_index.insert(100, vec![200]);

        let part_to_parent = propagate_voids_to_parts(&mut void_index, content, &mut decoder);

        // The slab inherits the skylight opening …
        assert_eq!(void_index.get(&101), Some(&vec![200]));
        // … but is NOT in the merge-layers map (not an IfcBuildingElementPart).
        assert!(part_to_parent.is_empty());
    }
}
