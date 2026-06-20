// SPDX-License-Identifier: MPL-2.0
//! Serde structs for the Honeybee HBJSON model schema (geometry subset).
//!
//! Field names/tags mirror exactly what `honeybee-schema` serializes (verified by
//! round-tripping honeybee-written `.hbjson` through this crate). `Face3D.plane` is
//! intentionally omitted — Honeybee derives it from the boundary on load.

use serde::Serialize;

/// A planar polygon: an ordered, wound boundary of `[x, y, z]` points (metres, Z-up).
#[derive(Serialize)]
pub struct Face3D {
    #[serde(rename = "type")]
    pub ty: &'static str, // "Face3D"
    pub boundary: Vec<[f64; 3]>,
}

impl Face3D {
    pub fn new(boundary: Vec<[f64; 3]>) -> Self {
        Self { ty: "Face3D", boundary }
    }
}

/// A boundary condition — minimal form (`{"type": "Outdoors"}` etc.), which Honeybee accepts.
#[derive(Serialize)]
pub struct BoundaryCondition {
    #[serde(rename = "type")]
    pub ty: &'static str, // "Outdoors" | "Ground" | "Surface" | "Adiabatic"
}

#[derive(Serialize)]
pub struct TypedProps {
    #[serde(rename = "type")]
    pub ty: &'static str,
}

/// A window — a planar sub-face of a parent wall Face, coplanar and within its boundary.
#[derive(Serialize)]
pub struct Aperture {
    #[serde(rename = "type")]
    pub ty: &'static str, // "Aperture"
    pub identifier: String,
    pub display_name: String,
    pub properties: TypedProps,
    pub geometry: Face3D,
    pub is_operable: bool,
    pub boundary_condition: BoundaryCondition,
}

impl Aperture {
    pub fn new(identifier: String, geometry: Face3D, is_operable: bool) -> Self {
        let display_name = identifier.clone();
        Self {
            ty: "Aperture",
            identifier,
            display_name,
            properties: TypedProps { ty: "AperturePropertiesAbridged" },
            geometry,
            is_operable,
            boundary_condition: BoundaryCondition { ty: "Outdoors" },
        }
    }
}

/// A door — a planar sub-face of a parent wall Face.
#[derive(Serialize)]
pub struct Door {
    #[serde(rename = "type")]
    pub ty: &'static str, // "Door"
    pub identifier: String,
    pub display_name: String,
    pub properties: TypedProps,
    pub geometry: Face3D,
    pub is_glass: bool,
    pub boundary_condition: BoundaryCondition,
}

impl Door {
    pub fn new(identifier: String, geometry: Face3D, is_glass: bool) -> Self {
        let display_name = identifier.clone();
        Self {
            ty: "Door",
            identifier,
            display_name,
            properties: TypedProps { ty: "DoorPropertiesAbridged" },
            geometry,
            is_glass,
            boundary_condition: BoundaryCondition { ty: "Outdoors" },
        }
    }
}

/// An arbitrary triangle mesh used for shading context (railings, balconies, etc.).
/// No watertightness required — the render mesh is the right source here.
#[derive(Serialize)]
pub struct Mesh3D {
    #[serde(rename = "type")]
    pub ty: &'static str, // "Mesh3D"
    pub vertices: Vec<[f64; 3]>,
    pub faces: Vec<[usize; 3]>,
}

#[derive(Serialize)]
pub struct ShadeMesh {
    #[serde(rename = "type")]
    pub ty: &'static str, // "ShadeMesh"
    pub identifier: String,
    pub display_name: String,
    pub properties: TypedProps,
    pub geometry: Mesh3D,
}

impl ShadeMesh {
    pub fn new(identifier: String, vertices: Vec<[f64; 3]>, faces: Vec<[usize; 3]>) -> Self {
        let display_name = identifier.clone();
        Self {
            ty: "ShadeMesh",
            identifier,
            display_name,
            properties: TypedProps { ty: "ShadeMeshPropertiesAbridged" },
            geometry: Mesh3D { ty: "Mesh3D", vertices, faces },
        }
    }
}

/// One face of a Room. `face_type` is "Wall" | "RoofCeiling" | "Floor" | "AirBoundary".
#[derive(Serialize)]
pub struct Face {
    #[serde(rename = "type")]
    pub ty: &'static str, // "Face"
    pub identifier: String,
    pub display_name: String,
    pub properties: TypedProps,
    pub geometry: Face3D,
    pub face_type: &'static str,
    pub boundary_condition: BoundaryCondition,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub apertures: Vec<Aperture>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub doors: Vec<Door>,
}

impl Face {
    pub fn new(identifier: String, geometry: Face3D, face_type: &'static str, bc: &'static str) -> Self {
        let display_name = identifier.clone();
        Self {
            ty: "Face",
            identifier,
            display_name,
            properties: TypedProps { ty: "FacePropertiesAbridged" },
            geometry,
            face_type,
            boundary_condition: BoundaryCondition { ty: bc },
            apertures: Vec::new(),
            doors: Vec::new(),
        }
    }
}

/// A closed volume of faces (one thermal zone).
#[derive(Serialize)]
pub struct Room {
    #[serde(rename = "type")]
    pub ty: &'static str, // "Room"
    pub identifier: String,
    pub display_name: String,
    pub properties: TypedProps,
    pub faces: Vec<Face>,
}

impl Room {
    pub fn new(identifier: String, faces: Vec<Face>) -> Self {
        let display_name = identifier.clone();
        Self {
            ty: "Room",
            identifier,
            display_name,
            properties: TypedProps { ty: "RoomPropertiesAbridged" },
            faces,
        }
    }
}

/// The top-level Honeybee model.
#[derive(Serialize)]
pub struct Model {
    #[serde(rename = "type")]
    pub ty: &'static str, // "Model"
    pub identifier: String,
    pub display_name: String,
    pub units: &'static str, // "Meters"
    pub properties: TypedProps,
    pub rooms: Vec<Room>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub shade_meshes: Vec<ShadeMesh>,
    pub tolerance: f64,
    pub angle_tolerance: f64,
    pub version: &'static str,
}

impl Model {
    pub fn new(identifier: &str, rooms: Vec<Room>, shade_meshes: Vec<ShadeMesh>, tolerance: f64) -> Self {
        Self {
            ty: "Model",
            identifier: identifier.to_string(),
            display_name: identifier.to_string(),
            units: "Meters",
            properties: TypedProps { ty: "ModelProperties" },
            rooms,
            shade_meshes,
            tolerance,
            angle_tolerance: 1.0,
            version: "1.0.0",
        }
    }
}
