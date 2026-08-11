// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Serde shapes for the Dragonfly (DFJSON) wire format.
//!
//! Pure data: every field here exists because the Dragonfly schema names it, so changes
//! are driven by the schema rather than by how ifc-lite extracts geometry. The extraction
//! itself lives in [`super::plates`] and [`super::stories`].

use serde::Serialize;

/// Honeybee/Dragonfly schema version this output targets (advisory; loaders warn but do
/// not hard-fail on a mismatch).
pub(super) const DF_VERSION: &str = "1.0.0";

#[derive(Serialize)]
pub struct TypedProps {
    #[serde(rename = "type")]
    pub ty: &'static str,
}

impl TypedProps {
    pub(super) fn new(ty: &'static str) -> Self {
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
