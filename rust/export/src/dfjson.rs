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
//! builder uses ([`crate::rooms::floor_profiles`]), so the two energy exports cannot drift
//! on which spaces they cover or where the footprints land.

use serde::Serialize;

use ifc_lite_geometry::ExtractedProfile;

use crate::rooms::floor_profiles;

/// Honeybee/Dragonfly schema version this output targets (advisory; loaders warn but do
/// not hard-fail on a mismatch).
const DF_VERSION: &str = "1.0.0";

/// Rooms whose floor heights fall within this band (metres) are grouped into one Story.
const STORY_GAP: f64 = 1.0;

#[derive(Serialize)]
pub struct TypedProps {
    #[serde(rename = "type")]
    pub ty: &'static str,
}

impl TypedProps {
    fn new(ty: &'static str) -> Self {
        Self { ty }
    }
}

/// One extruded floor plate. `floor_boundary` is counterclockwise (viewed from above) in
/// metres; `floor_height` is its Z and `floor_to_ceiling_height` the vertical extent.
#[derive(Serialize)]
pub struct Room2D {
    #[serde(rename = "type")]
    pub ty: &'static str, // "Room2D"
    pub identifier: String,
    pub display_name: String,
    pub properties: TypedProps,
    pub floor_boundary: Vec<[f64; 2]>,
    pub floor_height: f64,
    pub floor_to_ceiling_height: f64,
    pub is_ground_contact: bool,
    pub is_top_exposed: bool,
}

/// A horizontal grouping of `Room2D`s at one storey level.
#[derive(Serialize)]
pub struct Story {
    #[serde(rename = "type")]
    pub ty: &'static str, // "Story"
    pub identifier: String,
    pub display_name: String,
    pub properties: TypedProps,
    pub room_2ds: Vec<Room2D>,
    pub floor_to_floor_height: f64,
    pub floor_height: f64,
    pub multiplier: u32,
}

#[derive(Serialize)]
pub struct Building {
    #[serde(rename = "type")]
    pub ty: &'static str, // "Building"
    pub identifier: String,
    pub display_name: String,
    pub properties: TypedProps,
    pub unique_stories: Vec<Story>,
}

/// The top-level Dragonfly model.
#[derive(Serialize)]
pub struct Model {
    #[serde(rename = "type")]
    pub ty: &'static str, // "Model"
    pub identifier: String,
    pub display_name: String,
    pub units: &'static str, // "Meters"
    pub tolerance: f64,
    pub angle_tolerance: f64,
    pub properties: TypedProps,
    pub buildings: Vec<Building>,
    pub version: &'static str,
}

/// Intermediate per-space plate before story grouping.
struct Plate {
    express_id: u32,
    boundary: Vec<[f64; 2]>,
    floor_height: f64,
    ftc_height: f64,
}

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

/// Extract one `Room2D` plate per `IfcSpace` from the shared floor profiles: the lower
/// (floor) ring projected to 2D, its Z as `floor_height`, and the extrusion magnitude as
/// `floor_to_ceiling_height`. Boundaries are normalised to counterclockwise.
fn build_plates(profiles: &[ExtractedProfile], tol: f64) -> (Vec<Plate>, usize) {
    let (fps, _origin, mut skipped) = floor_profiles(profiles, tol);
    let mut plates = Vec::new();
    for fp in &fps {
        let floor = &fp.floor;
        // The floor ring is the lower of (ring, ring + dir*depth): pick whichever has the
        // smaller average Z so a downward extrusion still reads as floor-at-bottom.
        let avg_z = |r: &[[f64; 3]]| r.iter().map(|p| p[2]).sum::<f64>() / r.len().max(1) as f64;
        let floor_z = avg_z(floor);
        let ceil_z = floor_z + fp.dir[2] * fp.depth;
        // Take the boundary from whichever ring is actually the lower one. For a
        // downward extrusion that is the extruded ring, and an oblique `dir`
        // displaces it in XY as well as Z — so reading XY off the original ring
        // would place the plate correctly in Z but laterally offset by
        // `dir.xy * depth`. Vertical extrusions (the common case) are unaffected,
        // since their extruded ring has identical XY.
        let extruded: Vec<[f64; 3]> = floor
            .iter()
            .map(|p| {
                [
                    p[0] + fp.dir[0] * fp.depth,
                    p[1] + fp.dir[1] * fp.depth,
                    p[2] + fp.dir[2] * fp.depth,
                ]
            })
            .collect();
        let (lower_ring, lower, ftc) = if ceil_z >= floor_z {
            (floor.as_slice(), floor_z, ceil_z - floor_z)
        } else {
            // Downward extrusion: the "floor" is the lower ring (the extruded one).
            (extruded.as_slice(), ceil_z, floor_z - ceil_z)
        };
        if ftc <= tol {
            // Zero-height extrusion — not a usable room. Counted as skipped so
            // `stats.spaces == stats.rooms + stats.skipped` holds for callers
            // reporting coverage.
            skipped += 1;
            continue;
        }
        // Project to 2D and ensure counterclockwise winding (Dragonfly requirement).
        let mut boundary: Vec<[f64; 2]> = lower_ring.iter().map(|p| [p[0], p[1]]).collect();
        if signed_area_2d(&boundary) < 0.0 {
            boundary.reverse();
        }
        plates.push(Plate { express_id: fp.express_id, boundary, floor_height: lower, ftc_height: ftc });
    }
    (plates, skipped)
}

/// 2D signed area (positive = counterclockwise).
fn signed_area_2d(b: &[[f64; 2]]) -> f64 {
    let n = b.len();
    let mut a = 0.0;
    for i in 0..n {
        let j = (i + 1) % n;
        a += b[i][0] * b[j][1] - b[j][0] * b[i][1];
    }
    a * 0.5
}

/// Build the Dragonfly story list: sort plates by floor height and split into stories
/// wherever the floor-height gap exceeds `STORY_GAP`. Ground contact / top exposure are
/// flagged for the lowest / highest story.
fn build_stories(mut plates: Vec<Plate>) -> Vec<Story> {
    plates.sort_by(|a, b| a.floor_height.partial_cmp(&b.floor_height).unwrap_or(std::cmp::Ordering::Equal));

    // Cluster by floor-height gaps.
    let mut groups: Vec<Vec<Plate>> = Vec::new();
    for p in plates {
        match groups.last_mut() {
            Some(g) if (p.floor_height - g.last().unwrap().floor_height).abs() <= STORY_GAP => g.push(p),
            _ => groups.push(vec![p]),
        }
    }

    let n_groups = groups.len();
    // Dragonfly defines `floor_to_floor_height` as the slab-to-slab distance to the NEXT
    // story, so every group's floor height is needed up front to take the deltas below.
    let floor_heights: Vec<f64> = groups
        .iter()
        .map(|g| g.iter().map(|p| p.floor_height).fold(f64::MAX, f64::min))
        .collect();
    groups
        .into_iter()
        .enumerate()
        .map(|(si, group)| {
            let is_ground = si == 0;
            let is_top = si + 1 == n_groups;
            let floor_height = floor_heights[si];
            let avg_ftc = group.iter().map(|p| p.ftc_height).sum::<f64>() / group.len().max(1) as f64;
            // Slab-to-slab: elevation delta to the next story where one exists. The
            // topmost story has no next slab, so it falls back to the average
            // floor-to-ceiling height of its rooms (a non-positive delta gets the same
            // fallback, though the ascending sort makes that unreachable in practice).
            let ftf = match floor_heights.get(si + 1) {
                Some(&next) if next - floor_height > 0.0 => next - floor_height,
                _ => avg_ftc,
            };
            let room_2ds = group
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
                identifier: format!("Story_{}", si + 1),
                display_name: format!("Story {}", si + 1),
                properties: TypedProps::new("StoryPropertiesAbridged"),
                room_2ds,
                floor_to_floor_height: ftf,
                floor_height,
                multiplier: 1,
            }
        })
        .collect()
}

/// Build a Dragonfly [`Model`] from the `IfcSpace` profiles in `profiles`.
pub fn build_model(identifier: &str, profiles: &[ExtractedProfile], tol: f64) -> (Model, DfjsonStats) {
    let spaces = profiles.iter().filter(|p| p.ifc_type == "IfcSpace").count();
    let (plates, skipped) = build_plates(profiles, tol);
    let room_count = plates.len();
    let stories = build_stories(plates);
    let n_stories = stories.len();

    let buildings = if stories.is_empty() {
        Vec::new()
    } else {
        vec![Building {
            ty: "Building",
            identifier: "Building_1".to_string(),
            display_name: "Building 1".to_string(),
            properties: TypedProps::new("BuildingPropertiesAbridged"),
            unique_stories: stories,
        }]
    };

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
        let (model, stats) = build_model("test", &profiles, 0.01);
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
        let (model, stats) = build_model("test", &p_vec(p), 0.01);
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
    fn spaces_group_into_stories_by_height() {
        // Two spaces at Y=0, one at Y=3 → two stories (1.0 m gap threshold).
        let profiles = vec![unit_space(1, 0.0), unit_space(2, 0.0), unit_space(3, 3.0)];
        let (model, stats) = build_model("test", &profiles, 0.01);
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
        let (model, _stats) = build_model("test", &profiles, 0.01);
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
        let (_, stats) = build_model("test", &profiles, 0.01);
        assert_eq!(stats.spaces, 2);
        assert_eq!(stats.rooms, 1);
        assert_eq!(stats.skipped, 1, "zero-height extrusion must count as skipped");
        assert_eq!(stats.spaces, stats.rooms + stats.skipped, "coverage invariant");
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
