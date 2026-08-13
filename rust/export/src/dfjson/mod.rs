// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Serde structs + builder for the Dragonfly DFJSON model schema.
//!
//! Dragonfly (Ladybug Tools) represents a building as extruded 2D floor plates: each
//! `Room2D` is a horizontal `floor_boundary` polygon plus a `floor_height` and a
//! `floor_to_ceiling_height`. That maps directly onto an `IfcSpace`'s extruded-area
//! profile, so for the common case of vertical walls it is a simpler, lossless target than
//! the full Honeybee solid (recommended by Ladybug for mostly-vertical models).
//!
//! The floor footprint + heights come from the SAME analytic extraction the HBJSON room
//! builder uses ([`crate::rooms::floor_profiles`]), so the two exports agree on where a
//! footprint lands.
//!
//! They do NOT cover the same set of spaces, and that is by design rather than drift.
//! Downstream of the shared extraction each builder applies its own admissibility rules,
//! so measured on real models the counts differ in both directions:
//!
//! - DFJSON drops a space whose extrusion has (near-)zero vertical component — it fails the
//!   `ftc <= tol` check below — because a tilted prism has no faithful `Room2D`. HBJSON
//!   still emits a real solid for it (duplex.ifc: 19 HBJSON rooms vs 17 here).
//! - DFJSON keeps a space that HBJSON's watertightness gate rejects, since a 2D plate has no
//!   watertightness requirement to fail (rvt01.ifc: 46 HBJSON rooms vs 47 here).
//!
//! The duplicate-space pass IS shared in behaviour: [`plates::dedupe_colliding`] uses the
//! same thresholds as [`crate::rooms`]'s, so a model carrying duplicated `IfcSpace`
//! geometry (Revit does this) drops the same copies in both exports rather than
//! double-counting floor area here.

mod plates;
mod schema;
mod spatial;
mod stories;

use schema::{Building, Model, TypedProps};

use ifc_lite_geometry::ExtractedProfile;

use plates::{build_plates, dedupe_colliding};
use schema::DF_VERSION;
pub(crate) use spatial::spatial_index;
pub(crate) use spatial::SpatialIndex;
use stories::{build_stories, group_plates};

/// Coverage stats for a DFJSON export.
pub struct DfjsonStats {
    /// `IfcSpace` profiles seen in the model.
    pub spaces: usize,
    /// Room2Ds emitted.
    pub rooms: usize,
    /// Spaces skipped as degenerate (malformed footprint / holes / non-extrusion).
    pub skipped: usize,
    /// Stories grouped by floor level.
    pub stories: usize,
}

/// Build a Dragonfly [`Model`] from the `IfcSpace` profiles in `profiles`.
///
/// `spatial` carries the file's `IfcBuilding` / `IfcBuildingStorey` containment (issue
/// #1911). Pass `None` — or an empty index, for a file that declares no spatial
/// structure — to fall back to grouping stories by floor elevation and collapsing
/// everything into one synthetic building.
pub fn build_model(
    identifier: &str,
    profiles: &[ExtractedProfile],
    tol: f64,
    spatial: Option<&SpatialIndex>,
) -> (Model, DfjsonStats) {
    let spaces = profiles.iter().filter(|p| p.ifc_type == "IfcSpace").count();
    let (plates, mut skipped) = build_plates(profiles, tol);
    // Same duplicate-space pass HBJSON runs. Dropped duplicates count as skipped, so
    // `spaces == rooms + skipped` still holds for callers reporting coverage.
    let (plates, dropped) = dedupe_colliding(plates);
    skipped += dropped;
    let room_count = plates.len();
    let groups = group_plates(plates, spatial);

    // Partition the ordered stories by building, preserving order within each. Stories
    // with no building (unplaced plates that fell back to elevation clustering, or a
    // model with no spatial structure at all) go to the first building, so a plate is
    // never dropped for want of a parent.
    let mut buckets: Vec<(Option<u32>, Vec<stories::StoryGroup>)> = Vec::new();
    let ordered_buildings: Vec<u32> = match spatial.filter(|s| !s.is_empty()) {
        Some(s) => s.building_order.clone(),
        None => Vec::new(),
    };
    for b in &ordered_buildings {
        buckets.push((Some(*b), Vec::new()));
    }
    let mut orphans: Vec<stories::StoryGroup> = Vec::new();
    for g in groups {
        match g.building.and_then(|b| buckets.iter().position(|(id, _)| *id == Some(b))) {
            Some(i) => buckets[i].1.push(g),
            None => orphans.push(g),
        }
    }
    if !orphans.is_empty() {
        match buckets.first_mut() {
            Some((_, first)) => {
                first.extend(orphans);
                // The bucket's own order is by story elevation, which `group_plates`
                // already established globally; re-sorting keeps appended orphans in
                // place rather than stacked on the end.
                first.sort_by(|a, b| {
                    let ka = a.plates.iter().map(|p| p.floor_height).fold(f64::MAX, f64::min);
                    let kb = b.plates.iter().map(|p| p.floor_height).fold(f64::MAX, f64::min);
                    ka.partial_cmp(&kb).unwrap_or(std::cmp::Ordering::Equal)
                });
            }
            None => buckets.push((None, orphans)),
        }
    }

    let mut n_stories = 0usize;
    let mut buildings = Vec::new();
    for (bi, (id, groups)) in buckets.into_iter().enumerate() {
        if groups.is_empty() {
            // A building whose storeys hold no exportable space would otherwise emit an
            // empty `Building`, which Dragonfly reads as a real but roomless building.
            continue;
        }
        let identifier = format!("Building_{}", bi + 1);
        let display_name = id
            .and_then(|b| spatial.and_then(|s| s.building_names.get(&b)).cloned())
            .unwrap_or_else(|| format!("Building {}", bi + 1));
        let unique_stories = build_stories(groups, &format!("B{}_", bi + 1));
        n_stories += unique_stories.len();
        buildings.push(Building {
            ty: "Building",
            identifier,
            display_name,
            properties: TypedProps::new("BuildingPropertiesAbridged"),
            unique_stories,
        });
    }

    let model = Model {
        ty: "Model",
        identifier: identifier.to_string(),
        display_name: identifier.to_string(),
        units: "Meters",
        tolerance: tol,
        angle_tolerance: 1.0,
        properties: TypedProps::new("ModelProperties"),
        buildings,
        version: DF_VERSION,
    };
    let stats = DfjsonStats { spaces, rooms: room_count, skipped, stories: n_stories };
    (model, stats)
}

#[cfg(test)]
mod tests;
