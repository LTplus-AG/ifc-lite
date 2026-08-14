// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Grouping of extracted plates into Dragonfly stories.
//!
//! Preferred source is the file's own `IfcBuildingStorey` containment (issue
//! #1911): the spatial hierarchy is stated in the model, so re-deriving it from
//! floor elevations would only approximate it — and on real files it gets it
//! wrong (see [`super::spatial`]). Elevation clustering remains as the fallback
//! for plates the file never placed in a storey, and for whole models that
//! declare no spatial structure at all.

use std::collections::BTreeMap;

use super::plates::Plate;
use super::schema::{Room2D, Story, TypedProps};
use super::spatial::SpatialIndex;

/// Rooms whose floor heights fall within this band (metres) are grouped into one Story
/// when the file gives no storey to group them by.
const STORY_GAP: f64 = 1.0;

/// A story before it is serialized: its label, its ordering key, and its plates.
pub(super) struct StoryGroup {
    pub(super) label: Option<String>,
    /// Which `IfcBuilding` this story belongs to, when the file said so.
    pub(super) building: Option<u32>,
    pub(super) plates: Vec<Plate>,
}

/// Split `plates` into stories, using `IfcBuildingStorey` containment where the file
/// provides it and falling back to elevation clustering for whatever it does not.
///
/// The two paths coexist within one model on purpose: a file can place most of its
/// spaces and leave a handful loose, and dropping the loose ones (or forcing them into a
/// named storey they are not in) would both be worse than clustering them.
pub(super) fn group_plates(plates: Vec<Plate>, spatial: Option<&SpatialIndex>) -> Vec<StoryGroup> {
    let spatial = spatial.filter(|s| !s.is_empty());
    let Some(spatial) = spatial else {
        return cluster_by_elevation(plates)
            .into_iter()
            .map(|plates| StoryGroup { label: None, building: None, plates })
            .collect();
    };

    // BTreeMap keyed by storey id keeps assembly deterministic; the real ordering is
    // applied below, by declared elevation with the geometric floor height as the
    // tie-break (a file may omit `Elevation`, or repeat it across storeys).
    let mut placed: BTreeMap<u32, Vec<Plate>> = BTreeMap::new();
    let mut loose: Vec<Plate> = Vec::new();
    for p in plates {
        match spatial.space_storey.get(&p.express_id) {
            Some(storey) => placed.entry(*storey).or_default().push(p),
            None => loose.push(p),
        }
    }

    let mut groups: Vec<(Option<f64>, f64, StoryGroup)> = placed
        .into_iter()
        .map(|(storey, plates)| {
            let info = spatial.storeys.get(&storey);
            let floor = min_floor(&plates);
            (
                info.and_then(|i| i.elevation),
                floor,
                StoryGroup {
                    label: info.map(|i| i.name.clone()),
                    building: info.map(|i| i.building),
                    plates,
                },
            )
        })
        .collect();
    // Unplaced plates still get elevation clustering, and land in no building — the
    // caller drops them into the first building so they are never silently lost.
    for plates in cluster_by_elevation(loose) {
        let floor = min_floor(&plates);
        groups.push((None, floor, StoryGroup { label: None, building: None, plates }));
    }

    // A storey with no declared elevation sorts by its rooms' actual floor height, so
    // it interleaves with the declared ones rather than being banished to one end.
    groups.sort_by(|a, b| {
        let ka = a.0.unwrap_or(a.1);
        let kb = b.0.unwrap_or(b.1);
        ka.partial_cmp(&kb).unwrap_or(std::cmp::Ordering::Equal)
    });
    groups.into_iter().map(|(_, _, g)| g).collect()
}

fn min_floor(plates: &[Plate]) -> f64 {
    plates.iter().map(|p| p.floor_height).fold(f64::MAX, f64::min)
}

/// Sort by floor height and split wherever the gap exceeds [`STORY_GAP`].
fn cluster_by_elevation(mut plates: Vec<Plate>) -> Vec<Vec<Plate>> {
    plates.sort_by(|a, b| a.floor_height.partial_cmp(&b.floor_height).unwrap_or(std::cmp::Ordering::Equal));
    let mut groups: Vec<Vec<Plate>> = Vec::new();
    for p in plates {
        match groups.last_mut() {
            Some(g) if (p.floor_height - g.last().unwrap().floor_height).abs() <= STORY_GAP => g.push(p),
            _ => groups.push(vec![p]),
        }
    }
    groups
}

/// Serialize one building's ordered story groups into Dragonfly `Story` rows.
///
/// Ground contact / top exposure are flagged for the lowest / highest story OF THIS
/// BUILDING, so a two-building model does not mark one building's roof as interior.
///
/// `id_prefix` scopes the generated `identifier`s to the building. Dragonfly requires
/// story identifiers to be unique across the model, so two buildings both numbering
/// their stories from 1 would collide.
pub(super) fn build_stories(groups: Vec<StoryGroup>, id_prefix: &str) -> Vec<Story> {
    let n_groups = groups.len();
    // Dragonfly defines `floor_to_floor_height` as the slab-to-slab distance to the NEXT
    // story, so every group's floor height is needed up front to take the deltas below.
    let floor_heights: Vec<f64> = groups.iter().map(|g| min_floor(&g.plates)).collect();
    groups
        .into_iter()
        .enumerate()
        .map(|(si, group)| {
            let is_ground = si == 0;
            let is_top = si + 1 == n_groups;
            let floor_height = floor_heights[si];
            let plates = group.plates;
            let avg_ftc = plates.iter().map(|p| p.ftc_height).sum::<f64>() / plates.len().max(1) as f64;
            // Slab-to-slab: elevation delta to the next story where one exists. The
            // topmost story has no next slab, so it falls back to the average
            // floor-to-ceiling height of its rooms (a non-positive delta gets the same
            // fallback — reachable now that story ORDER can come from declared storey
            // elevations, which need not ascend with the rooms' geometric floors).
            let ftf = match floor_heights.get(si + 1) {
                Some(&next) if next - floor_height > 0.0 => next - floor_height,
                _ => avg_ftc,
            };
            // `identifier` must be unique and is what Dragonfly keys on; the IFC storey
            // Name goes to `display_name`, where a duplicate label ("Level 1" in two
            // buildings) is harmless.
            let display_name = group.label.unwrap_or_else(|| format!("Story {}", si + 1));
            let room_2ds = plates
                .into_iter()
                .map(|p| Room2D {
                    ty: "Room2D",
                    identifier: format!("R{}", p.express_id),
                    display_name: format!("R{}", p.express_id),
                    properties: TypedProps::new("Room2DPropertiesAbridged"),
                    floor_boundary: p.boundary,
                    floor_height: p.floor_height,
                    floor_to_ceiling_height: p.ftc_height,
                    is_ground_contact: is_ground,
                    is_top_exposed: is_top,
                })
                .collect();
            Story {
                ty: "Story",
                identifier: format!("{id_prefix}Story_{}", si + 1),
                display_name,
                properties: TypedProps::new("StoryPropertiesAbridged"),
                room_2ds,
                floor_to_floor_height: ftf,
                floor_height,
                multiplier: 1,
            }
        })
        .collect()
}
