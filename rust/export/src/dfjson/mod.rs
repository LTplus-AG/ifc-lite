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
mod tests {
    use super::*;
    use super::plates::signed_area_2d;

    /// A 4x5 m `IfcSpace` floor plate extruded 3 m up, at world height `elevation_y`.
    /// Mirrors what `extract_profiles` emits: the profile's local (x, y) lies in the
    /// horizontal plane (Y-up world: local x -> world x, local y -> world z) at world
    /// Y = elevation, extruded along +Y. (`xf` then converts to Honeybee Z-up.)
    fn unit_space(express_id: u32, elevation_y: f32) -> ExtractedProfile {
        // Column-major 4x4: col0 = world-x axis, col1 maps local-y onto world-z (row 2),
        // col3 = translation putting the plate at world Y = elevation.
        let mut transform = [0.0f32; 16];
        transform[0] = 1.0; // c(0,0): local x -> world x
        transform[6] = 1.0; // c(2,1): local y -> world z
        transform[13] = elevation_y; // c(1,3): world y translation (height)
        transform[15] = 1.0;
        ExtractedProfile {
            express_id,
            ifc_type: "IfcSpace".to_string(),
            outer_points: vec![0.0, 0.0, 4.0, 0.0, 4.0, 5.0, 0.0, 5.0],
            hole_counts: vec![],
            hole_points: vec![],
            transform,
            extrusion_dir: [0.0, 1.0, 0.0], // Y-up vertical extrusion
            extrusion_depth: 3.0,
            model_index: 0,
        }
    }

    #[test]
    fn single_space_becomes_one_room2d() {
        let profiles = vec![unit_space(42, 0.0)];
        let (model, stats) = build_model("test", &profiles, 0.01, None);
        assert_eq!(stats.spaces, 1);
        assert_eq!(stats.rooms, 1);
        assert_eq!(stats.stories, 1);

        let json = serde_json::to_value(&model).unwrap();
        assert_eq!(json["type"], "Model");
        assert_eq!(json["units"], "Meters");
        let story = &json["buildings"][0]["unique_stories"][0];
        let room = &story["room_2ds"][0];
        assert_eq!(room["type"], "Room2D");
        assert_eq!(room["identifier"], "R42");
        // Unit profile is 4x5 = 20 m^2, extruded 3 m.
        assert!((room["floor_to_ceiling_height"].as_f64().unwrap() - 3.0).abs() < 1e-6);
        let boundary = room["floor_boundary"].as_array().unwrap();
        assert_eq!(boundary.len(), 4, "square footprint has 4 corners");
        // Counterclockwise (positive signed area).
        let pts: Vec<[f64; 2]> = boundary
            .iter()
            .map(|p| [p[0].as_f64().unwrap(), p[1].as_f64().unwrap()])
            .collect();
        assert!(signed_area_2d(&pts) > 0.0, "boundary must be counterclockwise");
    }

    #[test]
    fn oblique_downward_extrusion_takes_its_boundary_from_the_lower_ring() {
        // A space whose profile sits at the TOP and extrudes downward along a
        // slanted direction: the lower ring is displaced in XY as well as Z, so
        // reading the boundary off the original (upper) ring would place the
        // plate laterally offset by `dir.xy * depth` while still reporting the
        // correct floor height — a silent horizontal shift of the whole room.
        let mut p = unit_space(7, 3.0);
        // Y-up world: extrude downward (-Y) with a +X lean. Normalised so the
        // vertical component is -0.8 over a depth of 5 => 4 m of drop, 3 m of
        // lateral travel.
        p.extrusion_dir = [0.6, -0.8, 0.0];
        p.extrusion_depth = 5.0;
        let (model, stats) = build_model("test", &p_vec(p), 0.01, None);
        assert_eq!(stats.rooms, 1);

        let json = serde_json::to_value(&model).unwrap();
        let room = &json["buildings"][0]["unique_stories"][0]["room_2ds"][0];
        assert!(
            (room["floor_to_ceiling_height"].as_f64().unwrap() - 4.0).abs() < 1e-6,
            "vertical drop is |dir.y| * depth = 4 m, not the 5 m slant length",
        );
        let xs: Vec<f64> = room["floor_boundary"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pt| pt[0].as_f64().unwrap())
            .collect();
        let min_x = xs.iter().cloned().fold(f64::INFINITY, f64::min);
        // The upper ring spans x in [0, 4]; the lower ring is that shifted by
        // dir.x * depth = +3, so it spans [3, 7]. Taking the upper ring's XY
        // would leave min_x at 0.
        assert!(
            (min_x - 3.0).abs() < 1e-6,
            "boundary must come from the lower (extruded) ring, got min_x = {min_x}",
        );
    }

    /// Helper: a single-profile vec, so the oblique test reads in one line.
    fn p_vec(p: ExtractedProfile) -> Vec<ExtractedProfile> {
        vec![p]
    }

    #[test]
    fn duplicated_space_geometry_is_deduped_not_double_counted() {
        // The Revit duplicate-space artifact: two IfcSpaces with identical footprint
        // and extent. Without a dedupe pass both become Room2Ds, the plates overlap,
        // and the energy model silently double-counts their floor area.
        let profiles = vec![unit_space(1, 0.0), unit_space(2, 0.0)];
        let (model, stats) = build_model("test", &profiles, 0.01, None);
        assert_eq!(stats.spaces, 2, "both spaces are seen");
        assert_eq!(stats.rooms, 1, "only one survives dedupe");
        assert_eq!(stats.skipped, 1, "the dropped duplicate is counted as skipped");
        assert_eq!(stats.spaces, stats.rooms + stats.skipped, "coverage identity holds");

        let json = serde_json::to_value(&model).unwrap();
        let rooms = json["buildings"][0]["unique_stories"][0]["room_2ds"].as_array().unwrap();
        assert_eq!(rooms.len(), 1, "exactly one Room2D is emitted");
    }

    #[test]
    fn genuinely_distinct_adjacent_spaces_are_not_deduped() {
        // Guards the dedupe against over-firing: two same-size rooms side by side
        // share an area but not a centroid, so both must survive.
        let mut b = unit_space(2, 0.0);
        // Shift the second footprint 10 m along local x — far outside the 0.3 m
        // centroid tolerance.
        b.outer_points = vec![10.0, 0.0, 14.0, 0.0, 14.0, 5.0, 10.0, 5.0];
        let (_, stats) = build_model("test", &[unit_space(1, 0.0), b], 0.01, None);
        assert_eq!(stats.rooms, 2, "distinct adjacent rooms both survive");
        assert_eq!(stats.skipped, 0);
    }

    #[test]
    fn spaces_group_into_stories_by_height() {
        // Two spaces at Y=0, one at Y=3 → two stories (1.0 m gap threshold). The two
        // ground-level rooms must sit SIDE BY SIDE: stacking identical footprints
        // would (correctly) trip the duplicate-space dedupe and leave only one.
        let mut neighbour = unit_space(2, 0.0);
        neighbour.outer_points = vec![10.0, 0.0, 14.0, 0.0, 14.0, 5.0, 10.0, 5.0];
        let profiles = vec![unit_space(1, 0.0), neighbour, unit_space(3, 3.0)];
        let (model, stats) = build_model("test", &profiles, 0.01, None);
        assert_eq!(stats.rooms, 3);
        assert_eq!(stats.stories, 2);
        let stories = model.buildings[0].unique_stories.len();
        assert_eq!(stories, 2);
        // Lowest story is ground contact, highest is top exposed.
        assert!(model.buildings[0].unique_stories[0].room_2ds[0].is_ground_contact);
        assert!(model.buildings[0].unique_stories[1].room_2ds[0].is_top_exposed);
    }

    #[test]
    fn floor_to_floor_uses_story_elevation_delta() {
        // Ground story at Y=0 (3 m floor-to-ceiling rooms), next story at Y=4: the
        // Dragonfly slab-to-slab distance is 4 m, not the 3 m ceiling height. The
        // topmost story has no next slab and falls back to floor-to-ceiling.
        let profiles = vec![unit_space(1, 0.0), unit_space(2, 4.0)];
        let (model, _stats) = build_model("test", &profiles, 0.01, None);
        let stories = &model.buildings[0].unique_stories;
        assert_eq!(stories.len(), 2);
        assert!(
            (stories[0].floor_to_floor_height - 4.0).abs() < 1e-6,
            "non-terminal story must use the elevation delta to the next story, got {}",
            stories[0].floor_to_floor_height
        );
        assert!(
            (stories[1].floor_to_floor_height - 3.0).abs() < 1e-6,
            "topmost story must fall back to average floor-to-ceiling height, got {}",
            stories[1].floor_to_floor_height
        );
    }

    #[test]
    fn zero_height_space_counts_as_skipped() {
        let mut flat = unit_space(9, 0.0);
        flat.extrusion_depth = 0.0;
        let profiles = vec![unit_space(8, 0.0), flat];
        let (_, stats) = build_model("test", &profiles, 0.01, None);
        assert_eq!(stats.spaces, 2);
        assert_eq!(stats.rooms, 1);
        assert_eq!(stats.skipped, 1, "zero-height extrusion must count as skipped");
        assert_eq!(stats.spaces, stats.rooms + stats.skipped, "coverage invariant");
    }

    /// A two-storey building whose spaces are `#5` (Level 1) and `#6` (Level 2), so the
    /// synthetic profiles below can be given matching express ids.
    fn two_storey_ifc() -> &'static str {
        r#"ISO-10303-21;
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
"#
    }

    /// Issue #1911's actual ask: the story split must come from `IfcBuildingStorey`, not
    /// from a guess at it. Two spaces at the SAME floor elevation on DIFFERENT storeys
    /// are one elevation cluster and two IFC storeys — so elevation grouping merges
    /// them and containment grouping does not.
    #[test]
    fn spaces_on_different_storeys_stay_apart_even_at_one_elevation() {
        // Side by side so the duplicate-space dedupe does not eat one of them.
        let mut b = unit_space(6, 0.0);
        b.outer_points = vec![10.0, 0.0, 14.0, 0.0, 14.0, 5.0, 10.0, 5.0];
        let profiles = vec![unit_space(5, 0.0), b];
        let idx = spatial_index(two_storey_ifc().as_bytes());

        let (elev_only, _) = build_model("test", &profiles, 0.01, None);
        assert_eq!(
            elev_only.buildings[0].unique_stories.len(),
            1,
            "control: by elevation alone these two rooms are one story",
        );

        let (model, stats) = build_model("test", &profiles, 0.01, Some(&idx));
        assert_eq!(stats.stories, 2, "the file places them on two storeys, so two stories");
        let stories = &model.buildings[0].unique_stories;
        assert_eq!(stories.len(), 2);
        assert_eq!(stories[0].display_name, "Level 1", "the IFC storey Name is carried");
        assert_eq!(stories[1].display_name, "Level 2");
        assert_eq!(
            model.buildings[0].display_name, "Main House",
            "the IfcBuilding Name is carried rather than a synthetic label",
        );
    }

    /// The converse, and the failure actually measured on `Office_A_20110811.ifc`: one
    /// storey whose spaces sit at different floor heights must stay ONE story. A 1 m
    /// elevation band splits them; containment does not.
    #[test]
    fn spaces_on_one_storey_stay_together_across_an_elevation_gap() {
        let mut sunken = unit_space(6, -1.5);
        sunken.outer_points = vec![10.0, 0.0, 14.0, 0.0, 14.0, 5.0, 10.0, 5.0];
        // Put BOTH spaces on storey #3 (Level 1).
        let ifc = two_storey_ifc().replace(
            "#13=IFCRELAGGREGATES('a4',$,$,$,#4,(#6));",
            "#13=IFCRELAGGREGATES('a4',$,$,$,#3,(#6));",
        );
        let profiles = vec![unit_space(5, 0.0), sunken];

        let (elev_only, _) = build_model("test", &profiles, 0.01, None);
        assert_eq!(
            elev_only.buildings[0].unique_stories.len(),
            2,
            "control: the 1.5 m drop splits them into two elevation clusters",
        );

        let idx = spatial_index(ifc.as_bytes());
        let (model, stats) = build_model("test", &profiles, 0.01, Some(&idx));
        assert_eq!(stats.stories, 1, "one IfcBuildingStorey means one Dragonfly Story");
        assert_eq!(model.buildings[0].unique_stories[0].room_2ds.len(), 2);
    }

    /// A model that declares no spatial structure must still export: the elevation
    /// heuristic stays as the fallback rather than every space becoming its own story.
    #[test]
    fn an_empty_spatial_index_falls_back_to_elevation_grouping() {
        let mut neighbour = unit_space(2, 0.0);
        neighbour.outer_points = vec![10.0, 0.0, 14.0, 0.0, 14.0, 5.0, 10.0, 5.0];
        let profiles = vec![unit_space(1, 0.0), neighbour, unit_space(3, 3.0)];
        // Ids 1/2/3 appear in no containment relationship in this file.
        let idx = spatial_index(two_storey_ifc().as_bytes());
        let (model, stats) = build_model("test", &profiles, 0.01, Some(&idx));
        assert_eq!(stats.rooms, 3, "unplaced spaces are exported, not dropped");
        assert_eq!(stats.stories, 2, "and grouped by elevation as before");
        assert_eq!(model.buildings.len(), 1);
    }

    /// Guards the shared extractor refactor: the same synthetic space yields a watertight
    /// HBJSON room (one Floor, one RoofCeiling, >=3 Walls).
    #[test]
    fn hbjson_room_builder_still_watertight() {
        let profiles = vec![unit_space(7, 0.0)];
        let (rooms, _origin, _skipped) = crate::rooms::build_rooms(&profiles, 0.01);
        assert_eq!(rooms.len(), 1);
        let faces = &rooms[0].faces;
        assert_eq!(faces.iter().filter(|f| f.face_type == "Floor").count(), 1);
        assert_eq!(faces.iter().filter(|f| f.face_type == "RoofCeiling").count(), 1);
        assert!(faces.iter().filter(|f| f.face_type == "Wall").count() >= 3);
    }
}

