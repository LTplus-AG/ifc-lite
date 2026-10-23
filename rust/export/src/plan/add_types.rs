// SPDX-License-Identifier: MPL-2.0
//! Public vocabulary of [`super::Disposition::Add`]: a genuinely new object,
//! described at the IFC level (class, GlobalId bits, placement matrix,
//! container, type, geometry, colour, property sets, an opening in a host).
//!
//! Nothing here is STEP text. Numbers are numbers, names are IFC EXPRESS
//! names, and every reference to something already in the file is an
//! [`ObjectRef`]. [`super::execute`] lowers the description into records in
//! whichever of IFC2X3/IFC4/IFC4X3 the source declares, so the same
//! description can land in any of them (a mesh becomes an
//! `IfcTriangulatedFaceSet` in IFC4 and an `IfcFacetedBrep` in IFC2X3, which
//! has no tessellated geometry).

use super::types::{ObjectRef, PsetKind, SurfaceColour, TriangleMesh};

/// The 128 bits of an `IfcGloballyUniqueId`, supplied by the caller so the
/// executor never has to invent an identity (no clock, no RNG: the output of
/// a plan is a pure function of the plan and the source).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GlobalId(pub u128);

impl GlobalId {
    pub fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(u128::from_be_bytes(bytes))
    }

    /// The 22-character IFC base-64 form written into the file.
    pub fn encode(self) -> String {
        ifc_lite_core::guid::encode(self.0)
    }

    /// A stable id for a record this object brings with it (its opening, its
    /// new type, a relationship created for it), derived from this id and a
    /// `role` tag. Same inputs, same id, on every run; different roles, or
    /// the same role under a different object, give unrelated ids.
    pub fn derive(self, role: &str) -> Self {
        Self(ifc_lite_core::guid::hash128(&format!("{:032x}/{role}", self.0)))
    }
}

/// The IFC class of a new object. The listed classes are the ones common
/// enough to name; anything else goes through [`IfcClass::Named`], which is
/// checked against the source schema (declared, not abstract, and of the
/// right kind: an `IfcProduct` for an object, an `IfcTypeObject` for a type).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IfcClass {
    Wall,
    Door,
    Window,
    Space,
    BuildingStorey,
    BuildingElementProxy,
    /// An EXPRESS entity name in any case, e.g. `IfcSlab` or `IfcWallType`.
    Named(String),
}

impl IfcClass {
    /// The UPPERCASE STEP keyword.
    pub fn keyword(&self) -> String {
        match self {
            IfcClass::Wall => "IFCWALL".into(),
            IfcClass::Door => "IFCDOOR".into(),
            IfcClass::Window => "IFCWINDOW".into(),
            IfcClass::Space => "IFCSPACE".into(),
            IfcClass::BuildingStorey => "IFCBUILDINGSTOREY".into(),
            IfcClass::BuildingElementProxy => "IFCBUILDINGELEMENTPROXY".into(),
            IfcClass::Named(name) => name.to_ascii_uppercase(),
        }
    }
}

/// A class plus the enumeration value for its `PredefinedType`, e.g.
/// `Some("PARTITIONING")` for a wall. The value is written as given
/// (upper-cased); a class whose schema declares no `PredefinedType` (IFC2X3's
/// `IfcDoor`, for one) refuses a `Some` rather than dropping it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassSpec {
    pub class: IfcClass,
    pub predefined_type: Option<String>,
}

/// Where a new object sits: `matrix` (row-major, file length units) is its
/// transform relative to `relative_to`.
#[derive(Debug, Clone)]
pub struct NewPlacement {
    pub matrix: [[f64; 4]; 4],
    /// An `IfcObjectPlacement` record, or a product whose `ObjectPlacement`
    /// is used (placements carry no GlobalId, so a product is the only way
    /// to name one by GlobalId). `None` places the object relative to its
    /// container's placement, or absolutely when it has no container.
    pub relative_to: Option<ObjectRef>,
}

/// A closed polygon profile swept along `direction` for `depth`. The
/// profile lies in the object's local XY plane; repeating the first point
/// at the end is allowed but not required.
#[derive(Debug, Clone)]
pub struct Extrusion {
    pub profile: Vec<[f64; 2]>,
    pub direction: [f64; 3],
    pub depth: f64,
}

#[derive(Debug, Clone)]
pub enum Representation {
    /// No `IfcProductDefinitionShape` at all.
    None,
    Extrusion(Extrusion),
    /// A mesh in the object's local coordinates.
    Mesh(TriangleMesh),
}

/// A property value, typed the way IFC types it.
#[derive(Debug, Clone)]
pub enum PropertyValue {
    Label(String),
    Text(String),
    Identifier(String),
    Boolean(bool),
    Integer(i64),
    Real(f64),
    /// A numeric measure by its IFC defined-type name, e.g. `IfcLengthMeasure`.
    /// Values are in the file's project units.
    Measure { measure_type: String, value: f64 },
}

#[derive(Debug, Clone)]
pub struct NewProperty {
    pub name: String,
    pub value: PropertyValue,
}

/// A property set (`kind: Property`) or quantity set (`kind: Quantity`,
/// every value a [`PropertyValue::Measure`] with a quantity entity) to
/// attach. Properties are written in the order given.
#[derive(Debug, Clone)]
pub struct NewPropertySet {
    pub name: String,
    pub kind: PsetKind,
    pub properties: Vec<NewProperty>,
}

/// A type object created alongside the occurrence. Types carry no placement
/// and no container; their sets are attached through `HasPropertySets`.
#[derive(Debug, Clone)]
pub struct NewType {
    /// The type's own GlobalId. `None` derives one from the occurrence that
    /// creates it (`derive("type")`); a caller that has its own identity for
    /// the type passes it here, so the type keeps that identity whichever
    /// occurrence happens to create it.
    pub global_id: Option<GlobalId>,
    pub class: ClassSpec,
    pub name: Option<String>,
    pub psets: Vec<NewPropertySet>,
}

impl NewType {
    /// The GlobalId this type is written with when `occurrence` creates it.
    pub fn global_id_for(&self, occurrence: GlobalId) -> GlobalId {
        self.global_id.unwrap_or_else(|| occurrence.derive("type"))
    }
}

#[derive(Debug, Clone)]
pub enum TypeLink {
    /// A type object already in the source (or added earlier in the plan).
    Existing(ObjectRef),
    New(NewType),
}

/// An `IfcOpeningElement` cut into `host`, placed at `matrix` (row-major,
/// file length units) in the NEW object's local frame, so the profile
/// describes the hole where the object will sit. When the new object is a
/// door or window, it also fills the opening.
#[derive(Debug, Clone)]
pub struct NewOpening {
    pub host: ObjectRef,
    pub matrix: [[f64; 4]; 4],
    pub shape: Extrusion,
}

/// Everything [`super::Disposition::Add`] builds.
///
/// The plan key paired with an Add names the new object in refusals. It must
/// not resolve to anything already in the source, and when it is an
/// [`ObjectRef::Guid`] it must equal `global_id.encode()`.
///
/// An Add is atomic: any part of the description that cannot be built
/// refuses the whole object, so the output never carries half of one.
#[derive(Debug, Clone)]
pub struct NewObject {
    pub global_id: GlobalId,
    pub class: ClassSpec,
    pub name: Option<String>,
    pub placement: NewPlacement,
    /// The spatial element the object belongs to. An element is contained
    /// through `IfcRelContainedInSpatialStructure`; a spatial element (a new
    /// storey or space) is aggregated into it through `IfcRelAggregates`.
    pub container: Option<ObjectRef>,
    pub type_link: Option<TypeLink>,
    pub representation: Representation,
    pub style: Option<SurfaceColour>,
    pub psets: Vec<NewPropertySet>,
    pub opening: Option<NewOpening>,
}

impl NewObject {
    /// Every existing object this Add names: its container, placement parent,
    /// type and opening host.
    pub(crate) fn references(&self) -> impl Iterator<Item = &ObjectRef> {
        [
            self.container.as_ref(),
            self.placement.relative_to.as_ref(),
            match &self.type_link {
                Some(TypeLink::Existing(r)) => Some(r),
                _ => None,
            },
            self.opening.as_ref().map(|o| &o.host),
        ]
        .into_iter()
        .flatten()
    }

    /// Every GlobalId this Add names: its own, and each [`ObjectRef::Guid`]
    /// it refers to. The executor's index keeps only the GlobalIds a plan
    /// names, so these are what an Add can look up.
    pub(crate) fn guids_to_look_up(&self) -> Vec<String> {
        let mut out = vec![self.global_id.encode()];
        if let Some(TypeLink::New(t)) = &self.type_link {
            out.push(t.global_id_for(self.global_id).encode());
        }
        out.extend(self.references().filter_map(|r| match r {
            ObjectRef::Guid(g) => Some(g.clone()),
            ObjectRef::Id(_) => None,
        }));
        out
    }
}
