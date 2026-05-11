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
use rustc_hash::FxHashMap;

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
    let mut scanner = EntityScanner::new(content);
    let mut propagations: Vec<(u32, Vec<u32>)> = Vec::new();
    let mut part_to_parent: FxHashMap<u32, u32> = FxHashMap::default();

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

        let children_attr = match entity.get(5) {
            Some(attr) => attr,
            None => continue,
        };
        let children: Vec<u32> = match children_attr.as_list() {
            Some(list) => list
                .iter()
                .filter_map(|item| item.as_entity_ref())
                .collect(),
            None => continue,
        };
        if children.is_empty() {
            continue;
        }

        // Verify the parent has its own representation. If it doesn't, the
        // layer parts ARE the only geometry — we still want to propagate
        // voids (in case the parent declares voids without geometry), but
        // we must not record the part → parent mapping that would let the
        // caller skip part emission.
        let parent_has_repr = decoder
            .decode_by_id(parent_id)
            .map(|p| p.get(6).map(|a| !a.is_null()).unwrap_or(false))
            .unwrap_or(false);

        let mut eligible_children = Vec::new();
        for child_id in children {
            if let Ok(child) = decoder.decode_by_id(child_id) {
                if child.ifc_type == IfcType::IfcBuildingElementPart {
                    let has_repr = child.get(6).map(|a| !a.is_null()).unwrap_or(false);
                    if has_repr {
                        eligible_children.push(child_id);
                        // Only record the mapping when the parent itself has
                        // geometry — otherwise the caller has no fallback.
                        if parent_has_repr {
                            part_to_parent.insert(child_id, parent_id);
                        }
                    }
                }
            }
        }

        if !eligible_children.is_empty() && void_index.contains_key(&parent_id) {
            propagations.push((parent_id, eligible_children));
        }
    }

    for (parent_id, children) in propagations {
        let parent_voids = match void_index.get(&parent_id) {
            Some(v) => v.clone(),
            None => continue,
        };
        for child_id in children {
            void_index
                .entry(child_id)
                .or_default()
                .extend(parent_voids.iter().copied());
        }
    }

    part_to_parent
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
}
