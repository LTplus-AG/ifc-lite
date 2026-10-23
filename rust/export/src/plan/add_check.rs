// SPDX-License-Identifier: MPL-2.0
//! The check phase of an Add: resolve every reference the description makes
//! and validate every value against the source schema, allocating nothing.
//! A child of `add` so it reads `AddState` without widening its fields.

use ifc_lite_core::{entity_info_for_schema, is_subtype_of_for_schema};

use crate::plan::add_geometry::validate_extrusion;
use crate::plan::tessellation::{validate_colour, validate_mesh};
use crate::plan::add_props::validate_psets;
use crate::plan::add_rels::RelKind;
use crate::plan::add_types::{ClassSpec, NewObject, Representation, TypeLink};
use crate::plan::attrs::attribute_index;
use crate::plan::types::ObjectRef;
use super::AddState;

/// What [`AddState::check`] resolved; everything the build needs that
/// depends on the file rather than on the description alone.
pub(super) struct Checked {
    pub(super) class: String,
    pub(super) predefined: Option<String>,
    pub(super) parent_placement: Option<u32>,
    pub(super) container: Option<(u32, RelKind)>,
    pub(super) existing_type: Option<u32>,
    pub(super) new_type: Option<(String, Option<String>)>,
    pub(super) host: Option<u32>,
    pub(super) fills: bool,
}

/// Reject an `IfcAxis2Placement3D` before it is built rather than after:
/// `axis_placement_records` reads the matrix's local X (column 0) and local
/// Z (column 2) as `IfcDirection`s, and a zero-length column or a pair that
/// does not actually span a plane produces a direction IFC forbids (zero
/// magnitude) or an axis system that does not describe an orientation at
/// all (X parallel to Z, so their cross product is zero).
fn validate_axes(m: &[[f64; 4]; 4]) -> Result<(), String> {
    let x = (m[0][0], m[1][0], m[2][0]);
    let z = (m[0][2], m[1][2], m[2][2]);
    let len = |v: (f64, f64, f64)| (v.0 * v.0 + v.1 * v.1 + v.2 * v.2).sqrt();
    // Written `!(x > eps)` so a NaN that overflow produced is refused too.
    if !(len(x) > 0.0) {
        return Err("placement matrix's X axis is zero-length".into());
    }
    if !(len(z) > 0.0) {
        return Err("placement matrix's Z axis is zero-length".into());
    }
    let cross = (x.1 * z.2 - x.2 * z.1, x.2 * z.0 - x.0 * z.2, x.0 * z.1 - x.1 * z.0);
    if !(len(cross) > 1e-9 * len(x) * len(z)) {
        return Err("placement matrix's X and Z axes are parallel".into());
    }
    Ok(())
}

impl AddState<'_> {
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
        // IFC4 keeps IFC2X3's door and window styles, deprecated but valid.
        let style = wanted.strip_suffix("TYPE").map(|base| format!("{base}STYLE"));
        if self.is_a(type_class, &wanted) || style.as_deref() == Some(type_class) {
            return Ok(());
        }
        Err(format!("{what} is {type_class}, but a {class} is typed by an {wanted}"))
    }

    /// A spatial element (`IfcSpatialStructureElement` in IFC2X3, its
    /// `IfcSpatialElement` supertype later).
    fn is_spatial(&self, class: &str) -> bool {
        self.is_a(class, "IFCSPATIALSTRUCTUREELEMENT") || self.is_a(class, "IFCSPATIALELEMENT")
    }

    /// `(id, UPPERCASE class)` of an object in the source or added earlier
    /// in this plan. A source object this plan deletes is not there, but an
    /// object added under its GlobalId is.
    fn lookup(&self, r: &ObjectRef) -> Result<(u32, String), String> {
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

    fn check_class(&self, spec: &ClassSpec, kind: &str) -> Result<(String, Option<String>), String> {
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
                // USERDEFINED obliges an ObjectType or ElementType naming the
                // kind, which an Add does not write.
                if upper == "USERDEFINED" {
                    return Err("PredefinedType USERDEFINED needs a type name, which an Add does not write".into());
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

    pub(super) fn check(&self, key: &ObjectRef, obj: &NewObject) -> Result<Checked, String> {
        let encoded = obj.global_id.encode();
        let live_in_source = |id: &u32| !self.removed.contains(id);
        if self.index.resolve(key).is_some_and(|id| live_in_source(&id)) {
            return Err(format!("{key} already exists in the source"));
        }
        if let ObjectRef::Guid(g) = key {
            if *g != encoded {
                return Err(format!("key {g} does not match the Add's GlobalId {encoded}"));
            }
        }
        let in_source = self.index.resolve(&ObjectRef::Guid(encoded.clone()));
        if in_source.is_some_and(|id| live_in_source(&id)) || self.added.contains_key(&encoded) {
            return Err(format!("GlobalId {encoded} is already in use"));
        }

        let (class, predefined) = self.check_class(&obj.class, "IFCPRODUCT")?;
        let spatial = self.is_spatial(&class);

        let container = match &obj.container {
            None => None,
            Some(r) => {
                let (id, c) = self.lookup(r)?;
                // A new site, building or (IFC4X3) other facility is
                // aggregated into the project.
                let top_level = || ["IFCSITE", "IFCBUILDING", "IFCFACILITY"].iter().any(|t| self.is_a(&class, t));
                if !(self.is_spatial(&c) || (c == "IFCPROJECT" && top_level())) {
                    return Err(format!("container {r} is {c}, not a spatial element"));
                }
                Some((id, if spatial { RelKind::Aggregates } else { RelKind::Contained }, c))
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
        if obj.placement.matrix.iter().flatten().any(|v| !v.is_finite()) {
            return Err("placement matrix is not finite".into());
        }
        validate_axes(&obj.placement.matrix)?;

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
                validate_psets(self.schema, &t.psets)?;
                let type_gid = obj.global_id.derive("type").encode();
                let in_source = self.index.resolve(&ObjectRef::Guid(type_gid.clone()));
                if in_source.is_some_and(|id| live_in_source(&id)) || self.added.contains_key(&type_gid) {
                    return Err(format!("GlobalId {type_gid} for the new type is already in use"));
                }
                let (type_class, predefined) = self.check_class(&t.class, "IFCTYPEPRODUCT")?;
                self.check_type_pairing(&class, &type_class, "new type")?;
                (None, Some((type_class, predefined)))
            }
        };

        validate_psets(self.schema, &obj.psets)?;
        match &obj.representation {
            Representation::None => {}
            Representation::Extrusion(e) => validate_extrusion(e)?,
            Representation::Mesh(m) => validate_mesh(m)?,
        }
        if let Some(c) = &obj.style {
            if matches!(obj.representation, Representation::None) {
                return Err("a colour needs a representation to apply to".into());
            }
            validate_colour(c)?;
        }

        let host = match &obj.opening {
            None => None,
            Some(op) => {
                let (id, c) = self.lookup(&op.host)?;
                if !self.is_a(&c, "IFCELEMENT") {
                    return Err(format!("opening host {} is {c}, not an element", op.host));
                }
                validate_extrusion(&op.shape).map_err(|e| format!("opening: {e}"))?;
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
        })
    }
}
