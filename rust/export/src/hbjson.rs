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

/// A boundary condition. `Outdoors`/`Ground` are the bare form; `Surface` (interior adjacency)
/// also carries the adjacent face + room identifiers.
#[derive(Serialize)]
pub struct BoundaryCondition {
    #[serde(rename = "type")]
    pub ty: &'static str, // "Outdoors" | "Ground" | "Surface" | "Adiabatic"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boundary_condition_objects: Option<Vec<String>>,
}

impl BoundaryCondition {
    pub fn new(ty: &'static str) -> Self {
        Self { ty, boundary_condition_objects: None }
    }
    /// A `Surface` boundary condition pointing at the adjacent `[face, room]`.
    pub fn surface(adjacent_face: String, adjacent_room: String) -> Self {
        Self { ty: "Surface", boundary_condition_objects: Some(vec![adjacent_face, adjacent_room]) }
    }
}

#[derive(Serialize)]
pub struct TypedProps {
    #[serde(rename = "type")]
    pub ty: &'static str,
}

/// A Honeybee energy material (one opaque layer). Thicknesses come from the IFC material
/// layer set; thermal properties are defaulted by material-name keyword (IFC rarely carries
/// conductivity/density), so U-values are a sensible starting point, not authoritative.
#[derive(Serialize, Clone)]
pub struct EnergyMaterial {
    #[serde(rename = "type")]
    pub ty: &'static str, // "EnergyMaterial"
    pub identifier: String,
    pub roughness: &'static str, // "MediumRough"
    pub thickness: f64,
    pub conductivity: f64,
    pub density: f64,
    pub specific_heat: f64,
    pub thermal_absorptance: f64,
    pub solar_absorptance: f64,
    pub visible_absorptance: f64,
}

impl EnergyMaterial {
    pub fn new(identifier: String, thickness: f64, conductivity: f64, density: f64, specific_heat: f64) -> Self {
        Self {
            ty: "EnergyMaterial",
            identifier,
            roughness: "MediumRough",
            thickness,
            conductivity,
            density,
            specific_heat,
            thermal_absorptance: 0.9,
            solar_absorptance: 0.7,
            visible_absorptance: 0.7,
        }
    }
}

/// An opaque construction referencing its materials (outside → inside) by identifier.
#[derive(Serialize, Clone)]
pub struct OpaqueConstruction {
    #[serde(rename = "type")]
    pub ty: &'static str, // "OpaqueConstructionAbridged"
    pub identifier: String,
    pub materials: Vec<String>,
}

impl OpaqueConstruction {
    pub fn new(identifier: String, materials: Vec<String>) -> Self {
        Self { ty: "OpaqueConstructionAbridged", identifier, materials }
    }
}

/// Per-face energy properties carrying an optional construction reference.
#[derive(Serialize)]
pub struct FaceEnergy {
    #[serde(rename = "type")]
    pub ty: &'static str, // "FaceEnergyPropertiesAbridged"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub construction: Option<String>,
}

#[derive(Serialize)]
pub struct FaceProperties {
    #[serde(rename = "type")]
    pub ty: &'static str, // "FacePropertiesAbridged"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub energy: Option<FaceEnergy>,
}

/// Model-level energy properties: the material + construction libraries.
#[derive(Serialize)]
pub struct ModelEnergy {
    #[serde(rename = "type")]
    pub ty: &'static str, // "ModelEnergyProperties"
    pub materials: Vec<EnergyMaterial>,
    pub constructions: Vec<OpaqueConstruction>,
}

#[derive(Serialize)]
pub struct ModelProperties {
    #[serde(rename = "type")]
    pub ty: &'static str, // "ModelProperties"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub energy: Option<ModelEnergy>,
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
            boundary_condition: BoundaryCondition::new("Outdoors"),
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
            boundary_condition: BoundaryCondition::new("Outdoors"),
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
    pub properties: FaceProperties,
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
            properties: FaceProperties { ty: "FacePropertiesAbridged", energy: None },
            geometry,
            face_type,
            boundary_condition: BoundaryCondition::new(bc),
            apertures: Vec::new(),
            doors: Vec::new(),
        }
    }

    /// Assign an opaque construction (by identifier) to this face's energy properties.
    pub fn set_construction(&mut self, construction: String) {
        self.properties.energy = Some(FaceEnergy {
            ty: "FaceEnergyPropertiesAbridged",
            construction: Some(construction),
        });
    }

    /// Make this face an interior `Surface` adjacency to `(adj_face, adj_room)`. Drops any
    /// apertures/doors — they were placed as exterior openings; interior openings need a
    /// matched pair on the other side (out of scope here).
    pub fn set_surface_bc(&mut self, adj_face: String, adj_room: String) {
        self.boundary_condition = BoundaryCondition::surface(adj_face, adj_room);
        self.apertures.clear();
        self.doors.clear();
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
    pub properties: ModelProperties,
    pub rooms: Vec<Room>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub shade_meshes: Vec<ShadeMesh>,
    pub tolerance: f64,
    pub angle_tolerance: f64,
    pub version: &'static str,
}

impl Model {
    pub fn new(
        identifier: &str,
        rooms: Vec<Room>,
        shade_meshes: Vec<ShadeMesh>,
        energy: Option<ModelEnergy>,
        tolerance: f64,
    ) -> Self {
        Self {
            ty: "Model",
            identifier: identifier.to_string(),
            display_name: identifier.to_string(),
            units: "Meters",
            properties: ModelProperties { ty: "ModelProperties", energy },
            rooms,
            shade_meshes,
            tolerance,
            angle_tolerance: 1.0,
            version: "1.0.0",
        }
    }
}
