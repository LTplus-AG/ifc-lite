// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The IFC spatial hierarchy behind Dragonfly's `Building` -> `Story` grouping.
//!
//! Issue #1911's argument for targeting DFJSON at all is that Dragonfly is
//! organised `Building` -> `Story` -> `Room2D`, which maps onto
//! `IfcBuilding` / `IfcBuildingStorey` / `IfcSpace` — where Honeybee's flat
//! room list throws the hierarchy away. Deriving stories from floor elevations
//! instead would re-approximate a partition the file already states: measured
//! on `Office_A_20110811.ifc`, an elevation heuristic splits the model's two
//! populated storeys into three stories, because one space sits 1.2 m below the
//! rest of its own level. So the containment edges are read here and used
//! directly; the elevation heuristic survives only as the fallback for a space
//! the file never placed (see [`super::stories`]).
//!
//! [`crate::relationships::relationships`] already resolves
//! `IfcRelAggregates` + `IfcRelContainedInSpatialStructure` into one
//! parent -> children map in a single pass, so this walks that map downward
//! from each `IfcBuilding` rather than scanning the file a second time. Only
//! the storey/building rows themselves are decoded again, for `Name` and
//! `Elevation`.

use std::collections::HashMap;

use ifc_lite_core::{EntityDecoder, EntityScanner};

use crate::relationships::relationships;

/// `Name` (attribute 2) is optional in IFC; `LongName` (7 on `IfcBuildingStorey`
/// and `IfcBuilding`) is the human label authoring tools more often fill in.
const ATTR_NAME: usize = 2;
const ATTR_LONG_NAME: usize = 7;
/// `IfcBuildingStorey.Elevation`, attribute 9.
const ATTR_ELEVATION: usize = 9;

/// One storey that carries spaces, with the label and ordering key to emit.
#[derive(Debug, Clone)]
pub(super) struct StoreyInfo {
    pub(super) name: String,
    /// Declared `Elevation`, used only to ORDER stories. Room floor heights come
    /// from geometry, because a storey's declared elevation and its spaces'
    /// actual floor plane disagree often enough (`Office_A`: 0.0 vs 1.22) that
    /// trusting it would move every plate.
    pub(super) elevation: Option<f64>,
    pub(super) building: u32,
}

/// The spatial facts DFJSON needs: which storey holds each space, which building
/// holds each storey, and what they are called.
#[derive(Debug, Default)]
pub(crate) struct SpatialIndex {
    /// `IfcSpace` express id -> containing `IfcBuildingStorey` express id.
    pub(super) space_storey: HashMap<u32, u32>,
    pub(super) storeys: HashMap<u32, StoreyInfo>,
    pub(super) building_names: HashMap<u32, String>,
    /// Buildings in file order, so a multi-building model emits deterministically.
    pub(super) building_order: Vec<u32>,
}

impl SpatialIndex {
    /// True when nothing usable was found — the caller then keeps the
    /// elevation-clustering path wholesale rather than emitting one story per
    /// unplaced space.
    pub(super) fn is_empty(&self) -> bool {
        self.space_storey.is_empty()
    }
}

/// Build the index from raw IFC STEP bytes.
///
/// A file with no `IfcBuilding` / `IfcBuildingStorey` (or with spaces attached
/// nowhere) yields an empty index rather than an error: DFJSON still exports,
/// it just falls back to grouping by elevation.
pub(crate) fn spatial_index(content: &[u8]) -> SpatialIndex {
    let rels = relationships(content);

    let mut out = SpatialIndex::default();
    // Decode the storey/building rows in one scan, recording file order for
    // buildings so the emitted `unique_stories` ordering is stable.
    //
    // No entity index: the only decode below is `decode_at_with_id` over the
    // scanner's own spans, and an index is read by `decode_by_id` alone.
    let mut decoder = EntityDecoder::new(content);
    let mut storey_rows: HashMap<u32, (String, Option<f64>)> = HashMap::new();
    let mut buildings: Vec<u32> = Vec::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        let is_storey = type_name == "IFCBUILDINGSTOREY";
        let is_building = type_name == "IFCBUILDING";
        if !is_storey && !is_building {
            continue;
        }
        let Ok(row) = decoder.decode_at_with_id(id, start, end) else {
            continue;
        };
        let label = row
            .get(ATTR_NAME)
            .and_then(|a| a.as_string())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                row.get(ATTR_LONG_NAME)
                    .and_then(|a| a.as_string())
                    .filter(|s| !s.is_empty())
            })
            .map(str::to_string);
        if is_building {
            out.building_names
                .insert(id, label.unwrap_or_else(|| format!("Building {id}")));
            buildings.push(id);
        } else {
            let elevation = row.get(ATTR_ELEVATION).and_then(|a| a.as_float());
            storey_rows.insert(id, (label.unwrap_or_else(|| format!("Storey {id}")), elevation));
        }
    }
    out.building_order = buildings;

    // Walk down from each building: storeys are its (possibly nested) spatial
    // descendants, and spaces are the storey's. `IfcSpace` nests under
    // `IfcSpace` in real files, so the space side recurses too — a sub-space
    // belongs to the storey that holds its parent.
    let mut found: Vec<(u32, u32, usize)> = Vec::new(); // (storey, building, depth)
    for &building in &out.building_order {
        for (storey, depth) in descendants(&rels.spatial_children, building) {
            let Some((name, elevation)) = storey_rows.get(&storey) else {
                continue;
            };
            out.storeys.insert(
                storey,
                StoreyInfo { name: name.clone(), elevation: *elevation, building },
            );
            found.push((storey, building, depth));
        }
    }
    // Deepest storey first, so a space inside a NESTED storey (a mezzanine
    // decomposing its parent level) is claimed by that storey rather than by the
    // ancestor that also lists it as a descendant. `or_insert` then keeps the
    // nearest claim. Ties break on express id so the result does not depend on
    // traversal order.
    found.sort_by(|a, b| b.2.cmp(&a.2).then(a.0.cmp(&b.0)));
    for (storey, _, _) in found {
        for (space, _) in descendants(&rels.spatial_children, storey) {
            out.space_storey.entry(space).or_insert(storey);
        }
    }
    out
}

/// Every spatial descendant of `root` with its depth below `root`, excluding
/// `root` itself.
///
/// Breadth-first and visited-guarded: a malformed file can contain a containment
/// cycle, and a recursive walk over one would blow the stack on a path the
/// caller cannot act on. BFS (rather than a stack) is what makes the reported
/// depth the SHORTEST path to each node, which is the depth the caller ranks on.
fn descendants(children: &HashMap<u32, Vec<u32>>, root: u32) -> Vec<(u32, usize)> {
    let mut out = Vec::new();
    let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut queue: std::collections::VecDeque<(u32, usize)> = std::collections::VecDeque::new();
    queue.push_back((root, 0));
    seen.insert(root);
    while let Some((node, depth)) = queue.pop_front() {
        let Some(kids) = children.get(&node) else {
            continue;
        };
        for &k in kids {
            if seen.insert(k) {
                out.push((k, depth + 1));
                queue.push_back((k, depth + 1));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal project -> building -> storey -> space chain.
    const CHAIN: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('p',$,'P',$,$,$,$,$,$);
#2=IFCBUILDING('b',$,'Main House',$,$,$,$,$,.ELEMENT.,$,$,$);
#3=IFCBUILDINGSTOREY('s1',$,'Level 1',$,$,$,$,$,.ELEMENT.,0.);
#4=IFCBUILDINGSTOREY('s2',$,'Level 2',$,$,$,$,$,.ELEMENT.,3.1);
#5=IFCSPACE('sp1',$,'Kitchen',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);
#6=IFCSPACE('sp2',$,'Bedroom',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);
#10=IFCRELAGGREGATES('a1',$,$,$,#1,(#2));
#11=IFCRELAGGREGATES('a2',$,$,$,#2,(#3,#4));
#12=IFCRELAGGREGATES('a3',$,$,$,#3,(#5));
#13=IFCRELAGGREGATES('a4',$,$,$,#4,(#6));
ENDSEC;
END-ISO-10303-21;
"#;

    #[test]
    fn resolves_space_to_storey_to_building_with_names() {
        let idx = spatial_index(CHAIN.as_bytes());
        assert!(!idx.is_empty());
        assert_eq!(idx.space_storey.get(&5), Some(&3), "kitchen sits on Level 1");
        assert_eq!(idx.space_storey.get(&6), Some(&4), "bedroom sits on Level 2");

        let l1 = idx.storeys.get(&3).expect("Level 1 is indexed");
        assert_eq!(l1.name, "Level 1", "the IFC storey Name must ride through");
        assert_eq!(l1.building, 2);
        assert_eq!(l1.elevation, Some(0.0));
        assert_eq!(idx.storeys.get(&4).map(|s| s.elevation), Some(Some(3.1)));

        assert_eq!(idx.building_names.get(&2).map(String::as_str), Some("Main House"));
        assert_eq!(idx.building_order, vec![2]);
    }

    #[test]
    fn a_file_with_no_spatial_containment_yields_an_empty_index() {
        // Two loose spaces and nothing placing them: the caller must be able to
        // tell "no hierarchy" from "hierarchy with one storey" so it can fall
        // back to elevation clustering instead of emitting one story per space.
        let loose = CHAIN
            .replace("#12=IFCRELAGGREGATES('a3',$,$,$,#3,(#5));\n", "")
            .replace("#13=IFCRELAGGREGATES('a4',$,$,$,#4,(#6));\n", "");
        let idx = spatial_index(loose.as_bytes());
        assert!(idx.is_empty(), "no space is placed, so nothing can be grouped by storey");
    }

    #[test]
    fn a_containment_cycle_terminates_instead_of_recursing_forever() {
        // Malformed but survivable: storey #3 aggregates #4 and #4 aggregates
        // #3 back. The walk must stop, not overflow the stack.
        let cyclic = CHAIN.replace(
            "#13=IFCRELAGGREGATES('a4',$,$,$,#4,(#6));",
            "#13=IFCRELAGGREGATES('a4',$,$,$,#4,(#6,#3));\n#14=IFCRELAGGREGATES('a5',$,$,$,#3,(#4));",
        );
        let idx = spatial_index(cyclic.as_bytes());
        assert_eq!(idx.space_storey.get(&5), Some(&3));
        assert!(idx.space_storey.contains_key(&6));
    }

    #[test]
    fn a_space_in_a_nested_storey_belongs_to_that_storey_not_its_parent() {
        // A mezzanine (#4) decomposing Level 1 (#3), with space #6 on it. Both
        // storeys list #6 among their spatial descendants, so a traversal that
        // took whichever it reached first would put the mezzanine's room on
        // Level 1 roughly half the time.
        let mezzanine = CHAIN
            .replace(
                "#11=IFCRELAGGREGATES('a2',$,$,$,#2,(#3,#4));",
                "#11=IFCRELAGGREGATES('a2',$,$,$,#2,(#3));\n#14=IFCRELAGGREGATES('a6',$,$,$,#3,(#4));",
            );
        let idx = spatial_index(mezzanine.as_bytes());
        assert_eq!(idx.space_storey.get(&5), Some(&3), "Level 1 keeps its own space");
        assert_eq!(
            idx.space_storey.get(&6),
            Some(&4),
            "the mezzanine's space belongs to the mezzanine, not to the level above it",
        );
        assert_eq!(idx.storeys.get(&4).map(|s| s.building), Some(2), "still under the building");
    }

    #[test]
    fn a_nested_space_is_claimed_by_the_nearest_storey() {
        // #7 nests under space #5, which sits on Level 1: it must land on
        // Level 1 too rather than being dropped for having no direct edge.
        let nested = CHAIN.replace(
            "#12=IFCRELAGGREGATES('a3',$,$,$,#3,(#5));",
            "#7=IFCSPACE('sp3',$,'Pantry',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);\n#12=IFCRELAGGREGATES('a3',$,$,$,#3,(#5));\n#14=IFCRELAGGREGATES('a6',$,$,$,#5,(#7));",
        );
        let idx = spatial_index(nested.as_bytes());
        assert_eq!(idx.space_storey.get(&7), Some(&3), "nested space inherits its parent's storey");
    }
}
