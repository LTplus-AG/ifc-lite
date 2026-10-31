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
    Disposition, DroppedRepresentation, ExportPlan, ExportingApplication, ExportingPerson, GeometryPatch, ObjectRef, Patch, PlacementPatch, PlanContext, PropScope,
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
        Self { pset: pset.into(), prop: prop.into(), measure_type: measure_type.into(), literal: literal.into(), unit: None, kind, scope, target: None }
    }

    /// Write exactly the value record `express_id`, not the first property
    /// of this name in the first set of this name. See [`PropWrite::target`].
    pub fn with_target(mut self, express_id: u32) -> Self {
        self.target = Some(express_id);
        self
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

    /// A context with an exporting application, so a test of anything but
    /// attribution runs the way a real export does.
    #[cfg(test)]
    pub(crate) fn attributed() -> Self {
        Self::new().with_application(ExportingApplication::new("TestOrg", "TestApp", "test-app", "1.0", "2026-01-01T00:00:00"))
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

    pub fn with_application(mut self, application: ExportingApplication) -> Self {
        self.application = Some(application);
        self
    }

    pub fn with_file_name(mut self, file_name: impl Into<String>) -> Self {
        self.file_name = Some(file_name.into());
        self
    }
}

impl ExportingPerson {
    pub fn new(identification: impl Into<String>, name: impl Into<String>) -> Self {
        Self { identification: identification.into(), name: name.into() }
    }
}

impl ExportingApplication {
    pub fn new(
        developer: impl Into<String>,
        full_name: impl Into<String>,
        identifier: impl Into<String>,
        version: impl Into<String>,
        changed_at: impl Into<String>,
    ) -> Self {
        Self {
            developer: developer.into(),
            full_name: full_name.into(),
            identifier: identifier.into(),
            version: version.into(),
            person: None,
            changed_at: changed_at.into(),
        }
    }

    pub fn with_person(mut self, person: ExportingPerson) -> Self {
        self.person = Some(person);
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
        Self { project, site, building, true_north: None, map_conversion: None, application: None, file_name: None }
    }

    pub fn with_application(mut self, application: ExportingApplication) -> Self {
        self.application = Some(application);
        self
    }

    pub fn with_file_name(mut self, file_name: impl Into<String>) -> Self {
        self.file_name = Some(file_name.into());
        self
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::IDENTITY;

    #[test]
    fn each_setter_sets_its_field() {
        let w = PropWrite::new("S", "P", "IFCLABEL", "'x'", PsetKind::Property, PropScope::Type).with_unit("#5");
        assert_eq!((w.pset.as_str(), w.prop.as_str(), w.measure_type.as_str(), w.literal.as_str()), ("S", "P", "IFCLABEL", "'x'"));
        assert_eq!((w.unit.as_deref(), w.kind, w.scope), (Some("#5"), PsetKind::Property, PropScope::Type));
        let mesh = TriangleMesh::new(vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], vec![[0, 1, 2]]);
        let p = Patch::new()
            .with_name("N")
            .with_psets(vec![w])
            .with_placement(PlacementPatch::new(IDENTITY))
            .with_geometry(GeometryPatch::new(mesh).with_colour(SurfaceColour::new([1.0, 0.0, 0.0], 0.0)));
        assert_eq!(p.name.as_deref(), Some("N"));
        assert_eq!((p.psets.len(), p.psets[0].prop.as_str()), (1, "P"));
        assert_eq!(p.placement.map(|pl| pl.matrix), Some(IDENTITY));
        let g = p.geometry.as_ref().unwrap();
        assert_eq!((g.mesh.positions.clone(), g.mesh.triangles.clone()), (vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], vec![[0, 1, 2]]));
        assert_eq!(g.colour.map(|c| (c.rgb, c.transparency)), Some(([1.0, 0.0, 0.0], 0.0)));
        let c = PlanContext::new().with_author("a").with_organization("o").with_time_stamp("t");
        assert_eq!((c.author.as_deref(), c.organization.as_deref(), c.time_stamp.as_deref()), (Some("a"), Some("o"), Some("t")));
        let plan = ExportPlan::new(vec![(ObjectRef::Id(1), Disposition::Delete)]).with_context(c);
        assert!(matches!(plan.dispositions.as_slice(), [(ObjectRef::Id(1), Disposition::Delete)]));
        let ctx = &plan.context;
        assert_eq!((ctx.author.as_deref(), ctx.organization.as_deref(), ctx.time_stamp.as_deref()), (Some("a"), Some("o"), Some("t")));
        let m = MapConversion::new("EPSG:2056", 1.0, 2.0, 3.0).with_map_unit(MapUnit::Foot).with_x_axis(0.0, 1.0).with_scale(0.5);
        assert_eq!((m.crs_name.as_str(), m.eastings, m.northings, m.orthogonal_height), ("EPSG:2056", 1.0, 2.0, 3.0));
        assert_eq!((m.map_unit, m.x_axis_abscissa, m.x_axis_ordinate, m.scale), (MapUnit::Foot, 0.0, 1.0, Some(0.5)));
        let root = |n: u128, name: &str| SkeletonRoot::new(GlobalId(n)).with_name(name);
        let s = Skeleton::new(root(1, "P"), root(2, "S"), root(3, "B")).with_true_north([0.0, 1.0]).with_map_conversion(m);
        let roots = [&s.project, &s.site, &s.building].map(|r| (r.global_id, r.name.clone().unwrap()));
        assert_eq!(roots, [(GlobalId(1), "P".into()), (GlobalId(2), "S".into()), (GlobalId(3), "B".into())]);
        assert_eq!(s.true_north, Some([0.0, 1.0]));
        assert_eq!(s.map_conversion.as_ref().map(|m| (m.crs_name.as_str(), m.scale)), Some(("EPSG:2056", Some(0.5))));
        let r = Refusal::new(ObjectRef::Id(1), "r");
        assert_eq!((&r.object, r.reason.as_str()), (&ObjectRef::Id(1), "r"));
        let f = ValidationFinding::new(Some(4), "m");
        assert_eq!((f.express_id, f.message.as_str()), (Some(4), "m"));
        let d = DroppedRepresentation::new(ObjectRef::Id(2), 9, Some("Axis".into()));
        assert_eq!((&d.object, d.representation, d.identifier.as_deref()), (&ObjectRef::Id(2), 9, Some("Axis")));
    }
}
