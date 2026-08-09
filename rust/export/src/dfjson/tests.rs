// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit coverage for the DFJSON model builder in [`super`].
//!
//! Split out of `mod.rs` rather than left inline: with the tests attached the
//! module ran 446 lines, past the ~400-line split rule the `module_size_ratchet`
//! test enforces. `#[cfg(test)]` module files are exempt from that rule (they are
//! test code, not a production module), so the seam is the test/production
//! boundary rather than an arbitrary cut through the builder.

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
fn oblique_extrusion_is_skipped_rather_than_flattened_into_a_vertical_room() {
    // A leaning space: it extrudes downward with a large +X lean, so its ceiling
    // sits 3 m to the side of its floor. A `Room2D` is a floor polygon swept
    // STRAIGHT UP and cannot express that. Emitting one anyway would place the
    // floor correctly and every wall wrongly — silently, with no signal in the
    // stats — so the space is skipped and counted instead.
    let mut p = unit_space(7, 3.0);
    // Y-up world: extrude downward (-Y) with a +X lean. Normalised so the
    // vertical component is -0.8 over a depth of 5 => 4 m of drop, 3 m of
    // lateral travel (a ratio of 0.75, far past MAX_TILT_RATIO).
    p.extrusion_dir = [0.6, -0.8, 0.0];
    p.extrusion_depth = 5.0;
    let (model, stats) = build_model("test", &p_vec(p), 0.01, None);
    assert_eq!(stats.rooms, 0, "a leaning prism has no faithful Room2D");
    assert_eq!(stats.skipped, 1, "and must be REPORTED as skipped, not dropped silently");
    assert_eq!(stats.spaces, stats.rooms + stats.skipped, "coverage invariant");

    let json = serde_json::to_value(&model).unwrap();
    let rooms: Vec<_> = json["buildings"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|b| b["unique_stories"].as_array().cloned().unwrap_or_default())
        .flat_map(|s| s["room_2ds"].as_array().cloned().unwrap_or_default())
        .collect();
    assert!(rooms.is_empty(), "no Room2D may be emitted for a tilted space");
}

#[test]
fn a_sloped_floor_ring_is_skipped_rather_than_projected_flat() {
    // A vertical extrusion over a RAMPED floor plate: the ring rises 1 m across its
    // 5 m depth (~11°). Projecting it to 2D shrinks its area by cos(tilt) and
    // `floor_height` averages the slope away, so the room would export with a
    // quietly wrong floor area — the number energy loads are computed from.
    let mut p = unit_space(11, 0.0);
    // Tilt the profile plane: local y now maps onto world z (height) as well as
    // world -z(plan). c(1,1) lifts the far edge of the ring by 1 m over 5 m of depth.
    p.transform[5] = 0.2;
    let (_, stats) = build_model("test", &p_vec(p), 0.01, None);
    assert_eq!(stats.rooms, 0, "a sloped floor plate has no faithful Room2D");
    assert_eq!(stats.skipped, 1);
    assert_eq!(stats.spaces, stats.rooms + stats.skipped, "coverage invariant");
}

#[test]
fn a_vertical_downward_extrusion_takes_its_boundary_from_the_lower_ring() {
    // The case the tilt guard must NOT catch, and the one the lower-ring selection
    // exists for: a profile authored at the CEILING of the space, extruded straight
    // down. Its lower ring is the floor, so the plate must be read off that.
    //
    // `floor_profiles` rebases every ring against the model-wide minimum, and with a
    // single space that minimum IS this ring — so the profile sits at rebased z = 0
    // whatever `elevation_y` says, and extruding 3 m down puts the floor at -3.
    // Reading the UPPER ring instead would report 0, a full storey too high.
    let mut p = unit_space(9, 3.0);
    p.extrusion_dir = [0.0, -1.0, 0.0]; // Y-up world: straight down
    p.extrusion_depth = 3.0;
    let (model, stats) = build_model("test", &p_vec(p), 0.01, None);
    assert_eq!(stats.rooms, 1, "a straight-down extrusion is perfectly representable");
    assert_eq!(stats.skipped, 0);

    let json = serde_json::to_value(&model).unwrap();
    let room = &json["buildings"][0]["unique_stories"][0]["room_2ds"][0];
    let floor_height = room["floor_height"].as_f64().unwrap();
    assert!(
        (floor_height + 3.0).abs() < 1e-6,
        "floor must be the LOWER ring at -3 m, not the profile's own ring at 0; got {floor_height}",
    );
    assert!(
        (room["floor_to_ceiling_height"].as_f64().unwrap() - 3.0).abs() < 1e-6,
        "3 m of vertical drop, taken as a magnitude",
    );
}

#[test]
fn float_noise_in_a_vertical_extrusion_does_not_trip_the_tilt_guard() {
    // Bounding control for the two skip tests above: the guard must reject genuine
    // tilt without rejecting the f32 round-off that a real `extrusion_dir` carries.
    // Without this, tightening MAX_TILT_RATIO to 0 would still leave those tests
    // green while silently dropping every space in the model.
    let mut p = unit_space(13, 0.0);
    p.extrusion_dir = [1.0e-7, 1.0, 3.0e-7];
    let (_, stats) = build_model("test", &p_vec(p), 0.01, None);
    assert_eq!(stats.rooms, 1, "float noise is not a lean");
    assert_eq!(stats.skipped, 0);
}

/// Helper: a single-profile vec, so the single-space tests read in one line.
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
