// SPDX-License-Identifier: MPL-2.0
//! What a Rhino scene export can be asked for. The defaults are the decisions
//! recorded in `docs/architecture/rhino-3dm-export.md` ("Decisions").

use serde::Deserialize;

/// Output length unit. `Source` reads the IFC project length unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RhinoUnits {
    /// The project length unit when it is a Rhino unit, else metres with a warning.
    #[default]
    Source,
    Meters,
    Millimeters,
    Centimeters,
    Feet,
    Inches,
}

/// Which frame vertices are written in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RhinoCoordinates {
    /// The pipeline's mesh frame: IFC world for a model near the origin, the
    /// shifted frame for a rebased one (the shift goes to `IFC::WorldFromModel`).
    #[default]
    Local,
    /// IFC world coordinates (survey grid).
    World,
}

/// How objects are sorted onto layers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RhinoLayerScheme {
    /// Project / site / building / storey layers, one class sublayer per IFC class.
    #[default]
    SpatialClass,
    /// One layer per IFC class under the project root.
    Class,
    /// One layer per `IfcPresentationLayerAssignment` name under the project root.
    Presentation,
}

/// How much IFC data goes into each object's user text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RhinoProperties {
    /// Attributes plus every property and quantity, type sets inherited.
    #[default]
    All,
    /// `IFC::*` attribute keys only.
    Attributes,
    /// `IFC::GlobalId`, `IFC::Class` and `IFC::ExpressId` only.
    None,
}

/// Options for [`build_rhino_scene`](super::build_rhino_scene). The `.3dm`
/// archive version is an adapter option and is not here.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct RhinoSceneOptions {
    pub units: RhinoUnits,
    pub coordinates: RhinoCoordinates,
    pub layer_scheme: RhinoLayerScheme,
    /// Repeated mapped geometry becomes block definitions and instances.
    pub instancing: bool,
    pub properties: RhinoProperties,
    /// Emit `IfcSpace` objects (on a hidden layer).
    pub include_spaces: bool,
    /// Write the pipeline's vertex normals.
    pub normals: bool,
    /// Material-layer wall slicing.
    pub layer_slicing: bool,
    /// Exclude these express ids (hidden in the viewer).
    pub hidden: Vec<u32>,
    /// Restrict to these express ids. `None` is no filter; `Some(empty)` is an
    /// active filter that matches nothing (as `GltfOptions::isolated`).
    pub isolated: Option<Vec<u32>>,
    /// Exclude objects of these IFC classes.
    pub hidden_types: Vec<String>,
}

impl Default for RhinoSceneOptions {
    fn default() -> Self {
        Self {
            units: RhinoUnits::Source,
            coordinates: RhinoCoordinates::Local,
            layer_scheme: RhinoLayerScheme::SpatialClass,
            instancing: true,
            properties: RhinoProperties::All,
            include_spaces: true,
            normals: true,
            layer_slicing: false,
            hidden: Vec::new(),
            isolated: None,
            hidden_types: Vec::new(),
        }
    }
}
