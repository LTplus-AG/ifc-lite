// SPDX-License-Identifier: MPL-2.0
//! The check phase of an Add: resolve every reference the description makes
//! and validate every value against the source schema, allocating nothing.
//! A child of `add` so it reads `AddState` without widening its fields.

use ifc_lite_core::{entity_info_for_schema, is_subtype_of_for_schema};

use crate::plan::add_profile::validate_extrusion;
use crate::plan::tessellation::{validate_colour, validate_mesh};
use crate::plan::add_props::validate_psets;
use crate::plan::add_rels::RelKind;
use crate::plan::add_types::{ClassSpec, NewObject, NewType, Representation, TypeLink};
use crate::plan::attrs::attribute_index;
use crate::plan::types::{ObjectRef, SurfaceColour};
use super::assoc::{CheckedClassification, CheckedMaterial};
use super::mapped::MapPlan;
use super::same_as::ReusedRepresentation;
use super::units::CheckedUnits;
use super::AddState;

/// What [`AddState::check`] resolved; everything the build needs that
/// depends on the file rather than on the description alone.
pub(super) struct Checked {
    pub(super) class: String,
    pub(super) predefined: Option<String>,
    pub(super) parent_placement: Option<u32>,
    pub(super) container: Option<(u32, RelKind)>,
    pub(super) existing_type: Option<u32>,
    /// Class, `PredefinedType` and value units of a new type.
    pub(super) new_type: Option<(String, Option<String>, CheckedUnits)>,
    pub(super) host: Option<u32>,
    pub(super) fills: bool,
    pub(super) material: Option<CheckedMaterial>,
    pub(super) classifications: Vec<CheckedClassification>,
    pub(super) units: CheckedUnits,
    /// Where a mapped body's maps come from.
    pub(super) mapped: Option<MapPlan>,
    /// The source representations reused geometry repeats.
    pub(super) same_as: Option<Vec<ReusedRepresentation>>,
}

impl AddState<'_, '_> {
    pub(super) fn is_a(&self, class: &str, parent: &str) -> bool {
        is_subtype_of_for_schema(self.schema, class, parent)
    }

    /// The type class an occurrence of `class` must be typed by, when the
    /// schema declares one by name: `<class>Type`, with an `IfcWallStandardCase`
    /// taking an `IfcWallType`. `None` when there is none (an IFC2X3 door is
    /// typed by an `IfcDoorStyle`), and then any product type is accepted.
    fn type_class_for(&self, class: &str) -> Option<String> {
        let class = class.to_ascii_uppercase();
        let base = class.strip_suffix("STANDARDCASE").or_else(|| class.strip_suffix("ELEMENTEDCASE")).unwrap_or(&class);
        let candidate = format!("{base}TYPE");
        entity_info_for_schema(self.schema, &candidate).is_some().then_some(candidate)
    }

    /// Refuse typing an occurrence of `class` by `type_class` when the schema
    /// names the type its class takes and `type_class` is not one.
    fn check_type_pairing(&self, class: &str, type_class: &str, what: &str) -> Result<(), String> {
        let Some(wanted) = self.type_class_for(class) else { return Ok(()) };
        // IFC4 keeps IfcDoorStyle and IfcWindowStyle, but CorrectStyleAssigned
        // requires an IfcDoorType / IfcWindowType there. In IFC2X3 there is no
        // such type, so `type_class_for` is None and this is not reached.
        if self.is_a(type_class, &wanted) {
            return Ok(());
        }
        Err(format!("{what} is {type_class}, but a {class} is typed by an {wanted}"))
    }

    fn is_spatial(&self, class: &str) -> bool {
        crate::plan::attrs::is_spatial(self.schema, class)
    }

    /// A spatial structure element: what the site, building, storey, space
    /// hierarchy under the project is made of. Spatial zones and external
    /// spatial elements are spatial but not structure elements: they are
    /// contained in one, and a zone may only be aggregated under a zone.
    /// Unlike `attrs::in_structure` (a place in the tree), this excludes the
    /// project: it classifies what is being added, and a project is never added.
    fn is_structure_element(&self, class: &str) -> bool {
        self.is_a(class, "IFCSPATIALSTRUCTUREELEMENT")
    }

    /// Whether a `parent` (UPPERCASE class) may aggregate a new structure
    /// element `child`. Each rule names a kind and the kinds that may hold
    /// it; a child follows every rule for a kind it is (in IFC4X3 an
    /// `IfcBuilding` is an `IfcFacility`, so it may sit wherever one may).
    fn can_aggregate(&self, parent: &str, child: &str) -> bool {
        const RULES: [(&str, &[&str]); 6] = [
            ("IFCSITE", &["IFCPROJECT", "IFCSITE"]),
            ("IFCBUILDING", &["IFCPROJECT", "IFCSITE", "IFCBUILDING"]),
            ("IFCBUILDINGSTOREY", &["IFCBUILDING", "IFCBUILDINGSTOREY"]),
            ("IFCSPACE", &["IFCBUILDINGSTOREY", "IFCBUILDING", "IFCSITE", "IFCSPACE", "IFCFACILITY", "IFCFACILITYPART"]),
            ("IFCFACILITYPART", &["IFCFACILITY", "IFCFACILITYPART"]),
            ("IFCFACILITY", &["IFCPROJECT", "IFCSITE", "IFCFACILITY", "IFCFACILITYPART"]),
        ];
        let mut ruled = false;
        for (kind, parents) in RULES {
            if self.is_a(child, kind) {
                ruled = true;
                if parents.iter().any(|p| self.is_a(parent, p)) {
                    return true;
                }
            }
        }
        !ruled && self.is_structure_element(parent)
    }

    /// `(id, UPPERCASE class)` of an object in the source or added earlier
    /// in this plan. A source object this plan deletes is not there, but an
    /// object added under its GlobalId is.
    pub(super) fn lookup(&self, r: &ObjectRef) -> Result<(u32, String), String> {
        let deleted = match self.index.resolve(r) {
            Some(id) if !self.removed.contains(&id) => return Ok((id, self.index.type_of(id).unwrap_or_default())),
            Some(_) => true,
            None => false,
        };
        let added = match r {
            ObjectRef::Guid(g) => self.added.get(g).map(|a| (a.id, a.class.clone())),
            ObjectRef::Id(_) => None,
        };
        added.ok_or_else(|| if deleted { format!("{r} is deleted by this plan") } else { format!("{r} not found") })
    }

    fn placement_of(&self, id: u32, class: &str) -> Option<u32> {
        if let Some(&placement) = self.placement_of_added.get(&id) {
            return placement;
        }
        let idx = attribute_index(self.schema, class, "ObjectPlacement")?;
        self.index.attrs(id)?.into_iter().nth(idx)?.scalar
    }

    pub(super) fn check_class(&self, spec: &ClassSpec, kind: &str) -> Result<(String, Option<String>), String> {
        let class = spec.class.keyword();
        let schema = self.schema;
        let info = entity_info_for_schema(schema, &class).ok_or_else(|| format!("{class} is not declared in {schema}"))?;
        if info.is_abstract {
            return Err(format!("{class} is abstract in {schema}"));
        }
        if !self.is_a(&class, kind) {
            return Err(format!("{class} is not an {kind} in {schema}"));
        }
        let predefined = match &spec.predefined_type {
            None => None,
            Some(value) => {
                attribute_index(schema, &class, "PredefinedType").ok_or_else(|| format!("{class} has no PredefinedType in {schema}"))?;
                let upper = value.to_ascii_uppercase();
                if upper.is_empty() || !upper.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
                    return Err(format!("'{value}' is not an enumeration value"));
                }
                let members = crate::step_log::predefined_type_members(schema, &class).unwrap_or(&[]);
                if !members.is_empty() && !members.contains(&upper.as_str()) {
                    return Err(format!("'{value}' is not a PredefinedType of {class} in {schema}"));
                }
                Some(format!(".{upper}."))
            }
        };
        Ok((class, predefined))
    }

    /// Refuse a value for a string attribute `class` lacks in the schema,
    /// and a `USERDEFINED` `PredefinedType` without a non-blank `kind`
    /// (`ObjectType` or `ElementType`) naming what it is.
    fn check_string_attributes<'v>(&self, class: &str, predefined: Option<&str>, attrs: impl Iterator<Item = (&'static str, &'v str)>, kind: &str) -> Result<(), String> {
        let mut named = false;
        for (name, value) in attrs {
            if attribute_index(self.schema, class, name).is_none() {
                return Err(format!("{class} has no {name} in {}", self.schema));
            }
            named |= name == kind && !value.trim().is_empty();
        }
        if predefined == Some(".USERDEFINED.") && !named {
            return Err(format!("PredefinedType USERDEFINED needs an {kind} naming the kind"));
        }
        Ok(())
    }

    /// Refuse a plan key that names something already there, a GlobalId key
    /// other than the new record's own, and a GlobalId already in use.
    pub(super) fn check_new_identity(&self, key: &ObjectRef, encoded: &str) -> Result<(), String> {
        let live_in_source = |id: &u32| !self.removed.contains(id);
        if self.index.resolve(key).is_some_and(|id| live_in_source(&id)) {
            return Err(format!("{key} already exists in the source"));
        }
        if let ObjectRef::Guid(g) = key {
            if g != encoded {
                return Err(format!("key {g} does not match the Add's GlobalId {encoded}"));
            }
        }
        if self.gid_in_use(encoded) {
            return Err(format!("GlobalId {encoded} is already in use"));
        }
        Ok(())
    }

    /// Whether a live source record or an earlier Add carries `encoded`.
    fn gid_in_use(&self, encoded: &str) -> bool {
        let in_source = self.index.resolve(&ObjectRef::Guid(encoded.to_string()));
        in_source.is_some_and(|id| !self.removed.contains(&id)) || self.added.contains_key(encoded)
    }

    /// A new type's class, `PredefinedType` and value units, checked the same
    /// way whether it comes with an occurrence or on its own.
    pub(super) fn check_new_type(&self, t: &NewType) -> Result<(String, Option<String>, CheckedUnits), String> {
        // IfcTypeObject's own rule (WR1 in IFC2X3, NameRequired later).
        if t.name.is_none() {
            return Err("a new type needs a name".into());
        }
        validate_psets(self.schema, &t.psets)?;
        let (class, predefined) = self.check_class(&t.class, "IFCTYPEPRODUCT")?;
        self.check_string_attributes(&class, predefined.as_deref(), t.string_attributes(), "ElementType")?;
        if matches!(t.representation, Representation::Mapped(_)) {
            return Err("a type's representation cannot itself be mapped".into());
        }
        if matches!(t.representation, Representation::SameAs(_)) {
            return Err("a type's representation cannot reuse a product's".into());
        }
        check_representation(&t.representation, t.style.as_ref()).map_err(|e| format!("type: {e}"))?;
        Ok((class, predefined, self.check_units(&t.psets)?))
    }

    pub(super) fn check(&self, key: &ObjectRef, obj: &NewObject) -> Result<Checked, String> {
        let encoded = obj.global_id.encode();
        self.check_new_identity(key, &encoded)?;

        let (class, predefined) = self.check_class(&obj.class, "IFCPRODUCT")?;
        self.check_string_attributes(&class, predefined.as_deref(), obj.string_attributes(), "ObjectType")?;
        if let Some(e) = obj.elevation {
            if !self.is_a(&class, "IFCBUILDINGSTOREY") {
                return Err(format!("{class} has no Elevation; only a storey takes one"));
            }
            if !e.is_finite() {
                return Err(format!("storey elevation {e} is not finite"));
            }
        }
        let spatial = self.is_structure_element(&class);

        let container = match &obj.container {
            None if spatial => return Err(format!("a new {class} needs a container: nothing else would place it in the spatial tree")),
            None => None,
            Some(r) => {
                let (id, c) = self.lookup(r)?;
                // When the new object is itself a spatial zone or external spatial
                // element: it is not part of the project/site/building/storey/space
                // decomposition. buildingSMART
                // IFC4.3 (Spatial Decomposition): an IfcSpatialZone is "included
                // into the hierarchy using the Spatial Containment concept
                // (IfcRelContainedInSpatialStructure) and can be aggregated into a
                // functional hierarchy ... an IfcSpatialZone can only be composed
                // under another IfcSpatialZone". IfcExternalSpatialElement's
                // definition gives only PredefinedType and BoundedBy; its place is
                // fixed by IfcRelContainedInSpatialStructure.RelatingStructure
                // (an IfcSpatialElement in IFC4), so it is contained likewise.
                if !spatial && self.is_spatial(&class) {
                    let kind = if self.is_structure_element(&c) {
                        RelKind::Contained
                    } else if self.is_a(&class, "IFCSPATIALZONE") && self.is_a(&c, "IFCSPATIALZONE") {
                        RelKind::Aggregates
                    } else {
                        return Err(format!("container {r} is {c}, which cannot hold a {class}: it is contained in a spatial structure element (or, for a zone, composed under a zone)"));
                    };
                    Some((id, kind, c))
                } else {
                    // IfcRelContainedInSpatialStructure.RelatingStructure is an
                    // IfcSpatialElement, a spatial zone included. A structure
                    // element goes under the project or a structure element.
                    let is_container = if spatial { crate::plan::attrs::in_structure(self.schema, &c) } else { self.is_spatial(&c) };
                    if !is_container {
                        return Err(format!("container {r} is {c}, not a spatial element"));
                    }
                    if spatial && !self.can_aggregate(&c, &class) {
                        return Err(format!("container {r} is {c}, which cannot aggregate a {class} in {}", self.schema));
                    }
                    Some((id, if spatial { RelKind::Aggregates } else { RelKind::Contained }, c))
                }
            }
        };

        let parent_placement = match &obj.placement.relative_to {
            Some(r) => {
                let (id, c) = self.lookup(r)?;
                if self.is_a(&c, "IFCOBJECTPLACEMENT") {
                    Some(id)
                } else {
                    Some(self.placement_of(id, &c).ok_or_else(|| format!("placement parent {r} ({c}) has no ObjectPlacement"))?)
                }
            }
            None => container.as_ref().and_then(|(id, _, c)| self.placement_of(*id, c)),
        };
        // The placement patch's rule, checked before any id is allocated.
        crate::plan::placement::check_matrix(&obj.placement.matrix)?;

        let (existing_type, new_type) = match &obj.type_link {
            None => (None, None),
            Some(TypeLink::Existing(r)) => {
                let (id, c) = self.lookup(r)?;
                if !self.is_a(&c, "IFCTYPEPRODUCT") {
                    return Err(format!("type {r} is {c}, not a product type"));
                }
                self.check_type_pairing(&class, &c, &format!("type {r}"))?;
                (Some(id), None)
            }
            Some(TypeLink::New(t)) => {
                let type_gid = t.global_id_for(obj.global_id).encode();
                if type_gid == encoded {
                    return Err("a new type cannot share its occurrence's GlobalId".into());
                }
                if self.gid_in_use(&type_gid) {
                    return Err(format!("GlobalId {type_gid} for the new type is already in use"));
                }
                let checked = self.check_new_type(t)?;
                self.check_type_pairing(&class, &checked.0, "new type")?;
                (None, Some(checked))
            }
        };

        validate_psets(self.schema, &obj.psets)?;
        let units = self.check_units(&obj.psets)?;
        // IfcRelAssociatesMaterial never relates an opening or a virtual
        // element. IFC2X3 takes any other product; IFC4 and later only an
        // element, a structural member or a port.
        let void = self.is_a(&class, "IFCFEATUREELEMENTSUBTRACTION") || self.is_a(&class, "IFCVIRTUALELEMENT");
        let allowed = crate::schema_convert::targets_ifc2x3(self.schema)
            || ["IFCELEMENT", "IFCSTRUCTURALMEMBER", "IFCPORT"].iter().any(|t| self.is_a(&class, t));
        let takes_material = allowed && !void;
        if obj.material.is_some() && !takes_material {
            return Err(format!("{class} cannot carry a material"));
        }
        let material = obj.material.as_ref().map(|m| self.check_material(m)).transpose()?;
        let classifications = self.check_classifications(&obj.classifications)?;
        check_representation(&obj.representation, obj.style.as_ref())?;
        let mapped = self.check_mapped(obj, existing_type)?;
        let same_as = self.check_same_as(obj)?;

        let host = match &obj.opening {
            None => None,
            Some(op) => {
                let (id, c) = self.lookup(&op.host)?;
                if !self.is_a(&c, "IFCELEMENT") {
                    return Err(format!("opening host {} is {c}, not an element", op.host));
                }
                validate_extrusion(&op.shape).map_err(|e| format!("opening: {e}"))?;
                crate::plan::placement::check_matrix(&op.matrix).map_err(|e| format!("opening: {e}"))?;
                Some(id)
            }
        };
        let fills = host.is_some() && (self.is_a(&class, "IFCDOOR") || self.is_a(&class, "IFCWINDOW"));

        Ok(Checked {
            class,
            predefined,
            parent_placement,
            container: container.map(|(id, kind, _)| (id, kind)),
            existing_type,
            new_type,
            host,
            fills,
            material,
            classifications,
            units,
            mapped,
            same_as,
        })
    }
}

/// Refuse geometry that cannot be written validly, and a colour with
/// nothing to apply to. A mapped body's own rules are `check_mapped`'s, a
/// reused one's `check_same_as`'s.
fn check_representation(rep: &Representation, style: Option<&SurfaceColour>) -> Result<(), String> {
    match rep {
        Representation::None | Representation::Mapped(_) | Representation::SameAs(_) => {}
        Representation::Extrusion(e) => validate_extrusion(e)?,
        Representation::Extrusions(es) => {
            if es.is_empty() {
                return Err("a representation of extrusions needs at least one".into());
            }
            for (i, e) in es.iter().enumerate() {
                validate_extrusion(e).map_err(|err| format!("extrusion {i}: {err}"))?;
            }
        }
        Representation::Mesh(m) => validate_mesh(m)?,
    }
    if let Some(c) = style {
        if matches!(rep, Representation::None) {
            return Err("a colour needs a representation to apply to".into());
        }
        validate_colour(c)?;
    }
    Ok(())
}
