// SPDX-License-Identifier: MPL-2.0
//! `IfcGridPlacement.PlacementRelTo` for an IFC2X3 or IFC4 source converted to
//! IFC4X3 (#9026 item 14).
//!
//! IFC4X3 gives IfcGridPlacement the inherited `PlacementRelTo`, ahead of its
//! other attributes. Below IFC4X3 the attribute does not exist: the placement
//! sits in the frame of the IfcGrid that owns its axes. So the record cannot
//! pass through, and `$` is not enough either: in IFC4X3 `$` means the world
//! frame, which moves every element on a grid that is not at the origin. The
//! owning grid's `ObjectPlacement` says the same thing the source did.
//!
//! It is a pre-pass because a grid may follow the placements on it. The owner
//! rule is the reader's ([`ifc_lite_core::EntityDecoder::grid_of_axis`]): the
//! first grid in file order listing the location's first axis. Twin of
//! `packages/export/src/schema-grid-frames.ts`, pinned for both by
//! `tests/fixtures/schema_grid_placement_vectors.json`.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::step_slot::split_top_level_args;

pub(crate) const GRID: &str = "IFCGRID";
pub(crate) const INTERSECTION: &str = "IFCVIRTUALGRIDINTERSECTION";
pub(crate) const GRID_PLACEMENT: &str = "IFCGRIDPLACEMENT";

/// IfcGrid slots, the same in IFC2X3 and IFC4.
const OBJECT_PLACEMENT: usize = 5;
const AXIS_SLOTS: [usize; 3] = [7, 8, 9];
/// `IfcVirtualGridIntersection.IntersectingAxes`.
const INTERSECTING_AXES: usize = 0;
/// `(PlacementLocation, PlacementRefDirection)`: the IFC2X3 and IFC4 list.
const SOURCE_ARITY: usize = 2;

struct Grid {
    id: u32,
    placement: Option<u32>,
    /// Row by row, so an edit can replace one.
    axes: [Vec<u32>; 3],
}

/// The grids and intersections of one export, read before any record is written.
#[derive(Default)]
pub(crate) struct GridFrames {
    /// In file order, created grids after source ones: the first listing an axis owns it.
    grids: Vec<Grid>,
    first_axis: HashMap<u32, u32>,
    /// Grids this export leaves out: they have no placement to name.
    left_out: HashSet<u32>,
}

fn ref_id(token: &str) -> Option<u32> {
    token.trim().strip_prefix('#')?.trim().parse().ok()
}

fn ref_ids(value: &str) -> Vec<u32> {
    let inner = value.trim().strip_prefix('(').and_then(|r| r.strip_suffix(')'));
    inner.and_then(split_top_level_args).map_or_else(Vec::new, |items| items.iter().filter_map(|m| ref_id(m)).collect())
}

fn attributes(text: &str) -> Option<Vec<String>> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    (close > open).then(|| split_top_level_args(&text[open + 1..close])).flatten()
}

impl GridFrames {
    /// Read every grid and intersection of `content`.
    pub(crate) fn scan(content: &[u8]) -> Self {
        let mut frames = Self::default();
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((id, ty, start, end)) = scanner.next_entity() {
            if ty.eq_ignore_ascii_case(GRID) || ty.eq_ignore_ascii_case(INTERSECTION) {
                frames.note(id, ty, &String::from_utf8_lossy(&content[start..end]));
            }
        }
        frames
    }

    /// Register a grid or an intersection by its record text; the last record
    /// with an id wins, keeping its place in file order. An unreadable one
    /// changes nothing.
    pub(crate) fn note(&mut self, id: u32, ty: &str, text: &str) {
        let Some(args) = attributes(text) else { return };
        let slot = |i: usize| args.get(i).map_or("", String::as_str);
        if ty.eq_ignore_ascii_case(GRID) {
            let grid = Grid { id, placement: ref_id(slot(OBJECT_PLACEMENT)), axes: AXIS_SLOTS.map(|i| ref_ids(slot(i))) };
            match self.grids.iter_mut().find(|g| g.id == id) {
                Some(existing) => *existing = grid,
                None => self.grids.push(grid),
            }
        } else if ty.eq_ignore_ascii_case(INTERSECTION) {
            match ref_ids(slot(INTERSECTING_AXES)).first() {
                Some(axis) => self.first_axis.insert(id, *axis),
                None => self.first_axis.remove(&id),
            };
        }
    }

    /// Attribute edits of a known grid or intersection, by source slot.
    pub(crate) fn note_edits(&mut self, id: u32, edits: &BTreeMap<usize, String>) {
        if let Some(grid) = self.grids.iter_mut().find(|g| g.id == id) {
            if let Some(value) = edits.get(&OBJECT_PLACEMENT) {
                grid.placement = ref_id(value);
            }
            for (row, slot) in AXIS_SLOTS.iter().enumerate() {
                if let Some(value) = edits.get(slot) {
                    grid.axes[row] = ref_ids(value);
                }
            }
        } else if let (true, Some(value)) = (self.first_axis.contains_key(&id), edits.get(&INTERSECTING_AXES)) {
            match ref_ids(value).first() {
                Some(axis) => self.first_axis.insert(id, *axis),
                None => self.first_axis.remove(&id),
            };
        }
    }

    /// Say which grids this export writes.
    pub(crate) fn retain(&mut self, written: impl Fn(u32) -> bool) {
        self.left_out = self.grids.iter().map(|g| g.id).filter(|id| !written(*id)).collect();
    }

    /// The owning grid's placement as a slot value; `$` when nothing owns the
    /// axis or the grid has none.
    fn rel_to(&self, location: Option<u32>) -> String {
        let axis = location.and_then(|id| self.first_axis.get(&id));
        let owner = axis.and_then(|axis| self.grids.iter().find(|g| g.axes.iter().any(|row| row.contains(axis))));
        match owner {
            Some(Grid { id, placement: Some(placement), .. }) if !self.left_out.contains(id) => format!("#{placement}"),
            _ => "$".to_string(),
        }
    }

    /// An IfcGridPlacement's attributes in the IFC4X3 layout; `None` when
    /// `args` is not the source layout.
    pub(crate) fn lift(&self, args: &[String]) -> Option<Vec<String>> {
        (args.len() == SOURCE_ARITY).then(|| {
            let mut lifted = vec![self.rel_to(ref_id(&args[0]))];
            lifted.extend_from_slice(args);
            lifted
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn frames() -> GridFrames {
        let mut f = GridFrames::default();
        f.note(20, "IFCGRID", "#20=IFCGRID('g',$,$,$,$,#10,$,(#1),(#2),$,.NOTDEFINED.);");
        f.note(30, "IFCVIRTUALGRIDINTERSECTION", "#30=IFCVIRTUALGRIDINTERSECTION((#1,#2),(0.,0.,0.));");
        f.note(31, "IFCVIRTUALGRIDINTERSECTION", "#31=IFCVIRTUALGRIDINTERSECTION((#3,#2),(0.,0.,0.));");
        f
    }

    #[test]
    fn names_no_placement_of_a_grid_this_export_leaves_out() {
        let mut f = frames();
        assert_eq!(f.lift(&args(&["#30", "$"])), Some(args(&["#10", "#30", "$"])));
        f.retain(|id| id != 20);
        assert_eq!(f.lift(&args(&["#30", "$"])), Some(args(&["$", "#30", "$"])), "the frame would dangle");
    }

    #[test]
    fn an_edit_adding_an_axis_to_a_grid_gives_that_axis_its_owner() {
        let mut f = frames();
        assert_eq!(f.lift(&args(&["#31", "$"])), Some(args(&["$", "#31", "$"])));
        f.note_edits(20, &BTreeMap::from([(7, "(#1,#3)".to_string())]));
        assert_eq!(f.lift(&args(&["#31", "$"])), Some(args(&["#10", "#31", "$"])));
    }

    #[test]
    fn a_record_not_in_the_source_layout_is_left_alone() {
        assert_eq!(frames().lift(&args(&["#10", "#30", "$"])), None);
    }
}
