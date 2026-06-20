// SPDX-License-Identifier: MPL-2.0
//! Domain-format exporters for ifc-lite.
//!
//! Phase 1: **HBJSON** (Honeybee energy-model) room export — the analytic, watertight
//! IFC→Ladybug bridge. Apertures/doors/shades and a glTF migration follow.
//!
//! This is the Rust source of truth; CLI / SDK / wasm become thin callers (mirroring how
//! geometry already flows through `ifc-lite-wasm`).

mod hbjson;
mod openings;
mod rooms;

pub use hbjson::Model;

use ifc_lite_geometry::extract_profiles;

/// Options for HBJSON export.
pub struct HbjsonOptions {
    /// Model identifier / display name.
    pub name: String,
    /// Geometry tolerance in metres (Honeybee default 0.01).
    pub tolerance: f64,
}

impl Default for HbjsonOptions {
    fn default() -> Self {
        Self { name: "ifc_lite_model".to_string(), tolerance: 0.01 }
    }
}

/// Coverage stats for an HBJSON export.
pub struct HbjsonStats {
    /// `IfcSpace` profiles seen in the model.
    pub spaces: usize,
    /// Rooms emitted (watertight prisms).
    pub rooms: usize,
    /// Spaces skipped as degenerate (malformed footprint / holes / non-extrusion — P5).
    pub skipped: usize,
    /// Windows placed as Apertures on exterior wall faces.
    pub apertures: usize,
    /// Doors placed on exterior wall faces.
    pub doors: usize,
    /// Railing / context shade meshes emitted.
    pub shades: usize,
}

/// Export the `IfcSpace` volumes in `content` (raw IFC/STEP bytes) as an HBJSON string.
///
/// Rooms are built analytically from extruded-area profiles (watertight by construction);
/// faces are typed Floor / RoofCeiling / Wall with outward normals. Returns a Honeybee-valid
/// `Model` JSON ready to load via `honeybee.model.Model.from_hbjson`.
pub fn export_hbjson(content: &[u8], opts: &HbjsonOptions) -> String {
    export_hbjson_with_stats(content, opts).0
}

/// Like [`export_hbjson`] but also returns coverage stats (so callers can report how many
/// spaces were skipped instead of silently truncating).
pub fn export_hbjson_with_stats(content: &[u8], opts: &HbjsonOptions) -> (String, HbjsonStats) {
    let profiles = extract_profiles(content, 0);
    let spaces = profiles.iter().filter(|p| p.ifc_type == "IfcSpace").count();
    let (mut rooms, origin, skipped) = rooms::build_rooms(&profiles, opts.tolerance);
    openings::attach_openings(&profiles, &mut rooms, origin);

    let apertures = rooms.iter().flat_map(|r| &r.faces).map(|f| f.apertures.len()).sum();
    let doors = rooms.iter().flat_map(|r| &r.faces).map(|f| f.doors.len()).sum();
    // Shades (railings → ShadeMesh) need a wasm-safe per-element mesh and land in P3.
    let shades = 0;
    let stats = HbjsonStats { spaces, rooms: rooms.len(), skipped, apertures, doors, shades };

    let model = Model::new(&opts.name, rooms, Vec::new(), opts.tolerance);
    let json = serde_json::to_string(&model).expect("HBJSON model serializes");
    (json, stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Skip-if-absent fixture loader (matches the geometry crate convention — test
    /// models are staged, not git-tracked, so a fresh checkout returns `None`).
    fn fixture(rel: &str) -> Option<Vec<u8>> {
        let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
        std::fs::read(path).ok()
    }

    #[test]
    fn duplex_exports_valid_room_model() {
        let Some(bytes) = fixture("ara3d/duplex.ifc") else {
            return;
        };
        let (json, stats) = export_hbjson_with_stats(&bytes, &HbjsonOptions::default());
        // P2: windows and doors are placed on exterior walls.
        assert!(stats.apertures > 0, "expected windows, got {}", stats.apertures);
        assert!(stats.doors > 0, "expected doors, got {}", stats.doors);
        let v: Value = serde_json::from_str(&json).expect("valid JSON");

        assert_eq!(v["type"], "Model");
        assert_eq!(v["units"], "Meters");
        assert_eq!(v["tolerance"], 0.01);

        let rooms = v["rooms"].as_array().expect("rooms array");
        assert!(rooms.len() >= 15, "expected >=15 IfcSpace rooms, got {}", rooms.len());

        // Every room must have exactly one Floor + one RoofCeiling + >=3 Walls.
        for room in rooms {
            let faces = room["faces"].as_array().unwrap();
            let mut floor = 0;
            let mut roof = 0;
            let mut wall = 0;
            for f in faces {
                match f["face_type"].as_str().unwrap() {
                    "Floor" => floor += 1,
                    "RoofCeiling" => roof += 1,
                    "Wall" => wall += 1,
                    other => panic!("unexpected face_type {other}"),
                }
                // boundary must be a non-degenerate polygon
                assert!(f["geometry"]["boundary"].as_array().unwrap().len() >= 3);
            }
            assert_eq!(floor, 1, "room {} floors", room["identifier"]);
            assert_eq!(roof, 1, "room {} roofs", room["identifier"]);
            assert!(wall >= 3, "room {} walls={}", room["identifier"], wall);
        }
    }

    #[test]
    fn revit_georeferenced_model_does_not_collapse() {
        // rvt01 carries national-grid coordinates (~2.78e6); the origin-rebase must keep
        // room footprints sane (no f32 collapse).
        let Some(bytes) = fixture("various/rvt01.ifc") else {
            return;
        };
        let json = export_hbjson(&bytes, &HbjsonOptions::default());
        let v: Value = serde_json::from_str(&json).unwrap();
        let rooms = v["rooms"].as_array().unwrap();
        assert!(rooms.len() >= 30, "expected >=30 rooms, got {}", rooms.len());
        // No coordinate should exceed ~1km from the rebased origin.
        for room in rooms {
            for f in room["faces"].as_array().unwrap() {
                for p in f["geometry"]["boundary"].as_array().unwrap() {
                    for c in p.as_array().unwrap() {
                        assert!(c.as_f64().unwrap().abs() < 1000.0, "coordinate not rebased: {c}");
                    }
                }
            }
        }
    }
}
