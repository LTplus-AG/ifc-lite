//! Grouping of extracted plates into Dragonfly stories by floor elevation.

use super::plates::Plate;
use super::schema::{Room2D, Story, TypedProps};

/// Rooms whose floor heights fall within this band (metres) are grouped into one Story.
const STORY_GAP: f64 = 1.0;

/// Build the Dragonfly story list: sort plates by floor height and split into stories
/// wherever the floor-height gap exceeds `STORY_GAP`. Ground contact / top exposure are
/// flagged for the lowest / highest story.
pub(super) fn build_stories(mut plates: Vec<Plate>) -> Vec<Story> {
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

