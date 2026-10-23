// SPDX-License-Identifier: MPL-2.0
//! Constructors for the export plan's public types.
//!
//! The plan's structs and enums are `#[non_exhaustive]`, so a field or
//! variant added later is not a breaking change. `PropScope`, `PsetKind`
//! and the `GlobalId` newtype stay exhaustive: IFC closes them. Outside this crate a struct
//! is built with its `new` (the fields it cannot do without) and finished with
//! `with_*` setters, or by assigning its public fields:
//!
//! ```
//! use ifc_lite_export::plan::*;
//! let wall = NewObject::new(GlobalId(1), ClassSpec::new(IfcClass::Wall), NewPlacement::new(IDENTITY))
//!     .with_name("Wall")
//!     .with_container(ObjectRef::Id(70));
//! assert_eq!(wall.name.as_deref(), Some("Wall"));
//! ```
//!
//! The Add vocabulary's constructors are in `add_builders.rs`.

use super::add_types::GlobalId;
use super::skeleton::{MapConversion, MapUnit, Skeleton, SkeletonRoot};
use super::types::{
    Disposition, DroppedRepresentation, ExportPlan, GeometryPatch, ObjectRef, Patch, PlacementPatch, PlanContext, PropScope,
    PropWrite, PsetKind, Refusal, SurfaceColour, TriangleMesh, ValidationFinding,
};

impl PropWrite {
    /// A write into property `prop` of set `pset` of `literal`, STEP text
    /// typed `measure_type` (`PropWrite::new("Pset_WallCommon",
    /// "ThermalTransmittance", "IFCTHERMALTRANSMITTANCEMEASURE", "0.24", ..)`),
    /// keeping any unit the existing value carries.
    pub fn new(
        pset: impl Into<String>,
        prop: impl Into<String>,
        measure_type: impl Into<String>,
        literal: impl Into<String>,
        kind: PsetKind,
        scope: PropScope,
    ) -> Self {
        Self { pset: pset.into(), prop: prop.into(), measure_type: measure_type.into(), literal: literal.into(), unit: None, kind, scope }
    }

    /// The STEP text of the unit to write (`"#55"`, or `"$"` for none).
    pub fn with_unit(mut self, unit: impl Into<String>) -> Self {
        self.unit = Some(unit.into());
        self
    }
}

impl PlacementPatch {
    pub fn new(matrix: [[f64; 4]; 4]) -> Self {
        Self { matrix }
    }
}

impl TriangleMesh {
    pub fn new(positions: Vec<[f64; 3]>, triangles: Vec<[u32; 3]>) -> Self {
        Self { positions, triangles }
    }
}

impl SurfaceColour {
    pub fn new(rgb: [f64; 3], transparency: f64) -> Self {
        Self { rgb, transparency }
    }
}

impl GeometryPatch {
    pub fn new(mesh: TriangleMesh) -> Self {
        Self { mesh, colour: None }
    }

    pub fn with_colour(mut self, colour: SurfaceColour) -> Self {
        self.colour = Some(colour);
        self
    }
}

impl Patch {
    /// A patch that changes nothing until a setter names a concern.
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    pub fn with_psets(mut self, psets: Vec<PropWrite>) -> Self {
        self.psets = psets;
        self
    }

    pub fn with_placement(mut self, placement: PlacementPatch) -> Self {
        self.placement = Some(placement);
        self
    }

    pub fn with_geometry(mut self, geometry: GeometryPatch) -> Self {
        self.geometry = Some(geometry);
        self
    }
}

impl PlanContext {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_author(mut self, author: impl Into<String>) -> Self {
        self.author = Some(author.into());
        self
    }

    pub fn with_organization(mut self, organization: impl Into<String>) -> Self {
        self.organization = Some(organization.into());
        self
    }

    pub fn with_time_stamp(mut self, time_stamp: impl Into<String>) -> Self {
        self.time_stamp = Some(time_stamp.into());
        self
    }
}

impl Refusal {
    pub fn new(object: ObjectRef, reason: impl Into<String>) -> Self {
        Self { object, reason: reason.into() }
    }
}

impl ValidationFinding {
    pub fn new(express_id: Option<u32>, message: impl Into<String>) -> Self {
        Self { express_id, message: message.into() }
    }
}

impl DroppedRepresentation {
    pub fn new(object: ObjectRef, representation: u32, identifier: Option<String>) -> Self {
        Self { object, representation, identifier }
    }
}

impl ExportPlan {
    pub fn new(dispositions: Vec<(ObjectRef, Disposition)>) -> Self {
        Self { dispositions, context: PlanContext::default() }
    }

    pub fn with_context(mut self, context: PlanContext) -> Self {
        self.context = context;
        self
    }
}

impl SkeletonRoot {
    pub fn new(global_id: GlobalId) -> Self {
        Self { global_id, name: None }
    }

    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }
}

impl MapConversion {
    /// A conversion to the projected CRS `crs_name`, with the engineering
    /// origin at `eastings`, `northings` and `orthogonal_height` in metres,
    /// no rotation (X along grid east) and no scale.
    pub fn new(crs_name: impl Into<String>, eastings: f64, northings: f64, orthogonal_height: f64) -> Self {
        Self {
            crs_name: crs_name.into(),
            map_unit: MapUnit::Metre,
            eastings,
            northings,
            orthogonal_height,
            x_axis_abscissa: 1.0,
            x_axis_ordinate: 0.0,
            scale: None,
        }
    }

    pub fn with_map_unit(mut self, map_unit: MapUnit) -> Self {
        self.map_unit = map_unit;
        self
    }

    /// The engineering X axis in map coordinates; see the field docs.
    pub fn with_x_axis(mut self, abscissa: f64, ordinate: f64) -> Self {
        self.x_axis_abscissa = abscissa;
        self.x_axis_ordinate = ordinate;
        self
    }

    pub fn with_scale(mut self, scale: f64) -> Self {
        self.scale = Some(scale);
        self
    }
}

impl Skeleton {
    pub fn new(project: SkeletonRoot, site: SkeletonRoot, building: SkeletonRoot) -> Self {
        Self { project, site, building, true_north: None, map_conversion: None }
    }

    pub fn with_true_north(mut self, true_north: [f64; 2]) -> Self {
        self.true_north = Some(true_north);
        self
    }

    pub fn with_map_conversion(mut self, map_conversion: MapConversion) -> Self {
        self.map_conversion = Some(map_conversion);
        self
    }
}
