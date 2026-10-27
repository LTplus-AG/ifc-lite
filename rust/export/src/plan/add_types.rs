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

use super::add_assoc_types::{ClassificationLink, ClassificationSystem, LayerMaterial, MaterialLink, NewPropertySet, ValueUnit};
use super::types::{ObjectRef, SurfaceColour, TriangleMesh};

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
#[non_exhaustive]
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
#[non_exhaustive]
pub struct ClassSpec {
    pub class: IfcClass,
    pub predefined_type: Option<String>,
}

/// Where a new object sits: `matrix` (row-major, file length units) is its
/// transform relative to `relative_to`.
#[derive(Debug, Clone)]
#[non_exhaustive]
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
/// of a loop at the end is allowed but not required.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct Extrusion {
    pub profile: Vec<[f64; 2]>,
    /// Holes in the profile, each a closed polygon strictly inside it and
    /// apart from every other. Written as an
    /// `IfcArbitraryProfileDefWithVoids`; none writes an
    /// `IfcArbitraryClosedProfileDef`.
    pub voids: Vec<Vec<[f64; 2]>>,
    pub direction: [f64; 3],
    pub depth: f64,
}

#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum Representation {
    /// No `IfcProductDefinitionShape` at all.
    None,
    Extrusion(Extrusion),
    /// Several extruded solids, one item each in a single `Body`
    /// representation, such as a region in several disjoint parts. At least
    /// one. They are not checked for overlap: IFC reads a body as the union
    /// of its items, but a reader summing their volumes counts an overlap
    /// twice.
    Extrusions(Vec<Extrusion>),
    /// A mesh in the object's local coordinates.
    Mesh(TriangleMesh),
    /// No geometry of its own: the object instances its type's `Body`
    /// representation maps through `IfcMappedItem`s. The type is the
    /// object's `type_link`: a type in the source that has representation
    /// maps, or a new type with a `representation`. The colour is the
    /// type's.
    Mapped(MappedBody),
    /// Every representation of a product in the source (`Body`, `Axis`,
    /// `FootPrint`, `Box`, ...): the object gets its own
    /// `IfcProductDefinitionShape` and one representation per representation
    /// of that product (same context, identifier and type) listing the
    /// product's own items, so anything attached to an item, such as a style
    /// or an item-level layer, applies to both. Items are positioned relative
    /// to the object placement, so the object shows the same geometry at its
    /// own placement. The colour is the product's. Openings that void the
    /// product, its projections and the layer assignments of its
    /// representations are not carried; an object that needs openings
    /// declares its own.
    SameAs(ObjectRef),
}

/// How an object places its type's mapped representation: `transform`
/// (row-major, file length units) takes the map's coordinates into the
/// object's local frame. A rotation and a translation, no scale. Identity
/// puts the type's geometry at the object's placement, which is where most
/// files keep it.
#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
pub struct MappedBody {
    pub transform: [[f64; 4]; 4],
}

impl Representation {
    /// The extruded solids of an `Extrusion` or `Extrusions`; none for the
    /// other variants.
    pub(crate) fn extrusions(&self) -> &[Extrusion] {
        match self {
            Representation::Extrusion(e) => std::slice::from_ref(e),
            Representation::Extrusions(es) => es,
            Representation::None | Representation::Mesh(_) | Representation::Mapped(_) | Representation::SameAs(_) => &[],
        }
    }
}

/// A type object created alongside the occurrence. Types carry no placement
/// and no container; their sets are attached through `HasPropertySets`.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct NewType {
    /// The type's own GlobalId. `None` derives one from the occurrence that
    /// creates it (`derive("type")`); a caller that has its own identity for
    /// the type passes it here, so the type keeps that identity whichever
    /// occurrence happens to create it. One `TypeLink::New` creates the type;
    /// every other occurrence of it in the plan names it with
    /// `TypeLink::Existing(ObjectRef::Guid(..))`, which resolves to the type
    /// an earlier Add created (a second `TypeLink::New` with the same id is
    /// refused as already in use).
    pub global_id: Option<GlobalId>,
    pub class: ClassSpec,
    /// Required: `IfcTypeObject` needs a name, so a new type without one is
    /// refused.
    pub name: Option<String>,
    /// `Tag`, an identifier such as the authoring tool's id for the type.
    pub tag: Option<String>,
    /// `ElementType`: what kind of type it is, required with a `USERDEFINED`
    /// `PredefinedType`. Refused where the class has no `ElementType` in the
    /// file's schema, such as an `IfcDoorStyle` or `IfcWindowStyle`.
    pub element_type: Option<String>,
    pub psets: Vec<NewPropertySet>,
    /// The type's shared geometry, written once as an `IfcRepresentationMap`
    /// that every occurrence with a [`Representation::Mapped`] body
    /// instances. `Representation::None` writes no map; a type cannot itself
    /// be `Mapped`.
    pub representation: Representation,
    /// The colour of `representation`.
    pub style: Option<SurfaceColour>,
}

/// Every unit record the values of `psets` name.
fn unit_refs(psets: &[NewPropertySet]) -> impl Iterator<Item = &ObjectRef> {
    psets.iter().flat_map(|s| &s.properties).filter_map(|p| match &p.unit {
        Some(ValueUnit::Existing(r)) => Some(r),
        _ => None,
    })
}

impl NewType {
    /// The GlobalIds a type added on its own names: its own and each unit
    /// named by GlobalId.
    pub(crate) fn guids_to_look_up(&self) -> Vec<String> {
        let own = self.global_id.map(GlobalId::encode);
        let named = self.references().filter_map(|r| match r {
            ObjectRef::Guid(g) => Some(g.clone()),
            ObjectRef::Id(_) => None,
        });
        own.into_iter().chain(named).collect()
    }

    /// Every existing record this type names: the units of its values.
    pub(crate) fn references(&self) -> impl Iterator<Item = &ObjectRef> {
        unit_refs(&self.psets)
    }

    /// The optional string attributes that are set, by EXPRESS name.
    pub(crate) fn string_attributes(&self) -> impl Iterator<Item = (&'static str, &str)> + '_ {
        [("Tag", &self.tag), ("ElementType", &self.element_type)].into_iter().filter_map(|(a, v)| Some((a, v.as_deref()?)))
    }

    /// The GlobalId this type is written with when `occurrence` creates it.
    pub fn global_id_for(&self, occurrence: GlobalId) -> GlobalId {
        self.global_id.unwrap_or_else(|| occurrence.derive("type"))
    }
}

/// `New` is much larger than `Existing`; a plan holds one per Add, so the
/// space is not worth an indirection in the public shape.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum TypeLink {
    /// A type object already in the source (or added earlier in the plan).
    Existing(ObjectRef),
    New(NewType),
}

/// An `IfcOpeningElement` cut into `host`, placed at `matrix` (row-major,
/// file length units) in the NEW object's local frame, so the profile
/// describes the hole where the object will sit. When the new object is a
/// door or window, it also fills the opening. A `shape` with voids cuts a
/// ring, leaving the host's material inside each void.
#[derive(Debug, Clone)]
#[non_exhaustive]
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
#[non_exhaustive]
pub struct NewObject {
    pub global_id: GlobalId,
    pub class: ClassSpec,
    pub name: Option<String>,
    /// `LongName`, such as a space's room name beside the number in `name`.
    /// Refused where the class has no `LongName` in the file's schema.
    pub long_name: Option<String>,
    /// `Tag`, an identifier such as the authoring tool's id. Refused where
    /// the class has no `Tag` in the file's schema.
    pub tag: Option<String>,
    /// `ObjectType`: what kind of object it is, required with a
    /// `USERDEFINED` `PredefinedType`.
    pub object_type: Option<String>,
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
    pub material: Option<MaterialLink>,
    /// Written in the order given; one reference may not appear twice.
    pub classifications: Vec<ClassificationLink>,
    /// A storey's `Elevation`, in the project's length unit, written as
    /// given. Only an `IfcBuildingStorey` takes one. It does not move the
    /// storey: its placement is `placement`.
    pub elevation: Option<f64>,
}

impl NewObject {
    /// The optional string attributes that are set, by EXPRESS name.
    pub(crate) fn string_attributes(&self) -> impl Iterator<Item = (&'static str, &str)> + '_ {
        [("LongName", &self.long_name), ("Tag", &self.tag), ("ObjectType", &self.object_type)].into_iter().filter_map(|(a, v)| Some((a, v.as_deref()?)))
    }

    /// Every existing object this Add names: its container, placement parent,
    /// type, opening host, material, classifications and units.
    pub(crate) fn references(&self) -> impl Iterator<Item = &ObjectRef> {
        let type_ref = match &self.type_link {
            Some(TypeLink::Existing(r)) => Some(r),
            _ => None,
        };
        let new_type = match &self.type_link {
            Some(TypeLink::New(t)) => Some(t),
            _ => None,
        };
        let units = unit_refs(&self.psets).chain(new_type.into_iter().flat_map(NewType::references));
        let material = match &self.material {
            Some(MaterialLink::Existing(r)) => Some(r),
            _ => None,
        };
        let layer_materials = match &self.material {
            Some(MaterialLink::NewLayerSet(set)) => set.layers.as_slice(),
            _ => &[],
        };
        let layer_materials = layer_materials.iter().filter_map(|l| match &l.material {
            Some(LayerMaterial::Existing(r)) => Some(r),
            _ => None,
        });
        let classifications = self.classifications.iter().filter_map(|c| match c {
            ClassificationLink::Existing(r) => Some(r),
            ClassificationLink::New(n) => match &n.system {
                ClassificationSystem::Existing(r) => Some(r),
                ClassificationSystem::New(_) => None,
            },
        });
        [self.container.as_ref(), self.placement.relative_to.as_ref(), type_ref, self.opening.as_ref().map(|o| &o.host), material]
            .into_iter()
            .flatten()
            .chain(layer_materials)
            .chain(classifications)
            .chain(units)
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
        // Not one of `references`: those are kept from the delete cascade,
        // and reused geometry is read from what the deletes leave.
        if let Representation::SameAs(ObjectRef::Guid(g)) = &self.representation {
            out.push(g.clone());
        }
        out
    }
}

/// One Add of a plan, in plan order: an object, or a type on its own.
#[derive(Clone, Copy)]
pub(crate) enum AddItem<'p> {
    Object(&'p NewObject),
    Type(&'p NewType),
}

impl<'p> AddItem<'p> {
    /// Every existing record this Add names.
    pub(crate) fn references(self) -> Vec<&'p ObjectRef> {
        match self {
            AddItem::Object(o) => o.references().collect(),
            AddItem::Type(t) => t.references().collect(),
        }
    }
}
