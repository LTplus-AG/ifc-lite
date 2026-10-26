// SPDX-License-Identifier: MPL-2.0
//! An Add's associations: its material and its classification references.
//! A child of `add` so it resolves references through `AddState` like the
//! rest of the check phase.
//!
//! A record named by [`ObjectRef`] is used as it is. A new record is built
//! once per plan for each distinct description, through [`Shared`], so ten
//! copies asking for the same new material share one `IfcMaterial` and one
//! `IfcRelAssociatesMaterial`. A new unit is shared the same way (see
//! `add_units.rs`).

use std::collections::HashMap;

use crate::plan::add_assoc_types::{
    ClassificationLink, ClassificationSystem, LayerMaterial, MaterialLink, NewClassification, NewMaterial,
};
use crate::plan::add_rels::{RelKind, RelRequest};
use crate::plan::add_types::GlobalId;
use crate::plan::types::ObjectRef;
use crate::plan::attrs::attribute_index;
use crate::plan::placement::fmt;
use crate::plan::props_synth::{ref_list, ref_or_unset};
use crate::plan::tessellation::Emit;
use crate::step_text::quoted;

use super::units::NewSi;
use super::AddState;

/// A record in the source, or one to build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Target<N> {
    Existing(u32),
    New(N),
}

pub(super) enum CheckedMaterial {
    One(Target<NewMaterial>),
    LayerSet { name: Option<String>, layers: Vec<(Option<Target<NewMaterial>>, f64)> },
}

#[derive(PartialEq, Eq)]
pub(super) enum CheckedClassification {
    Existing(u32),
    New { system: Target<NewClassification>, identification: Option<String>, name: Option<String>, location: Option<String> },
}

impl AddState<'_, '_> {
    /// The id of `r`, which must be a `class` record.
    fn existing_of(&self, r: &ObjectRef, class: &str, what: &str) -> Result<u32, String> {
        let (id, c) = self.lookup(r)?;
        if c != class {
            return Err(format!("{what} {r} is {c}, not an {class}"));
        }
        Ok(id)
    }

    pub(super) fn check_material(&self, link: &MaterialLink) -> Result<CheckedMaterial, String> {
        Ok(match link {
            MaterialLink::Existing(r) => {
                let (id, c) = self.lookup(r)?;
                let accepted = ["IFCMATERIALDEFINITION", "IFCMATERIALUSAGEDEFINITION"].iter().any(|t| self.is_a(&c, t))
                    || ["IFCMATERIAL", "IFCMATERIALLIST", "IFCMATERIALLAYERSETUSAGE", "IFCMATERIALLAYERSET", "IFCMATERIALLAYER"]
                        .contains(&c.as_str());
                if !accepted {
                    return Err(format!("material {r} is {c}, not a material definition"));
                }
                CheckedMaterial::One(Target::Existing(id))
            }
            MaterialLink::New(m) => CheckedMaterial::One(self.check_new_material(m)?),
            MaterialLink::NewLayerSet(set) => {
                if set.layers.is_empty() {
                    return Err("a layer set needs at least one layer".into());
                }
                let ifc2x3 = crate::schema_convert::targets_ifc2x3(self.schema);
                let mut layers = Vec::with_capacity(set.layers.len());
                for (i, layer) in set.layers.iter().enumerate() {
                    // IfcPositiveLengthMeasure in IFC2X3, non-negative later.
                    let t = layer.thickness;
                    if !(t.is_finite() && (t > 0.0 || (t == 0.0 && !ifc2x3))) {
                        return Err(format!("layer {i} thickness {t} is not a valid layer thickness in {}", self.schema));
                    }
                    let material = match &layer.material {
                        None => None,
                        Some(LayerMaterial::Existing(r)) => Some(Target::Existing(self.existing_of(r, "IFCMATERIAL", "layer material")?)),
                        Some(LayerMaterial::New(m)) => Some(self.check_new_material(m)?),
                    };
                    layers.push((material, t));
                }
                CheckedMaterial::LayerSet { name: set.name.clone(), layers }
            }
        })
    }

    fn check_new_material(&self, m: &NewMaterial) -> Result<Target<NewMaterial>, String> {
        if m.name.is_empty() {
            return Err("a new material needs a name".into());
        }
        if m.category.is_some() && attribute_index(self.schema, "IFCMATERIAL", "Category").is_none() {
            return Err(format!("IfcMaterial has no Category in {}", self.schema));
        }
        Ok(Target::New(m.clone()))
    }

    pub(super) fn check_classifications(&self, links: &[ClassificationLink]) -> Result<Vec<CheckedClassification>, String> {
        let mut out: Vec<CheckedClassification> = Vec::with_capacity(links.len());
        for link in links {
            let checked = match link {
                ClassificationLink::Existing(r) => {
                    let (id, c) = self.lookup(r)?;
                    let system_allowed = !crate::schema_convert::targets_ifc2x3(self.schema) && c == "IFCCLASSIFICATION";
                    if !(c == "IFCCLASSIFICATIONREFERENCE" || system_allowed) {
                        return Err(format!("classification {r} is {c}, not a classification reference"));
                    }
                    CheckedClassification::Existing(id)
                }
                ClassificationLink::New(n) => {
                    let system = match &n.system {
                        ClassificationSystem::Existing(r) => Target::Existing(self.existing_of(r, "IFCCLASSIFICATION", "classification system")?),
                        ClassificationSystem::New(s) => {
                            if s.name.is_empty() {
                                return Err("a new classification needs a name".into());
                            }
                            if crate::schema_convert::targets_ifc2x3(self.schema) && (s.source.is_none() || s.edition.is_none()) {
                                return Err("IFC2X3 requires a classification's Source and Edition".into());
                            }
                            Target::New(s.clone())
                        }
                    };
                    // IfcExternalReference's rule: something must identify it.
                    if n.identification.is_none() && n.name.is_none() && n.location.is_none() {
                        return Err("a classification reference needs an identification, a name or a location".into());
                    }
                    CheckedClassification::New {
                        system,
                        identification: n.identification.clone(),
                        name: n.name.clone(),
                        location: n.location.clone(),
                    }
                }
            };
            if out.contains(&checked) {
                return Err("one classification reference appears twice".into());
            }
            out.push(checked);
        }
        Ok(out)
    }
}

/// The description a new shared record is reused by.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) enum SharedKey {
    Material(NewMaterial),
    /// Name, then each layer's material record and thickness bits.
    LayerSet(Option<String>, Vec<(Option<u32>, u64)>),
    Classification(NewClassification),
    /// System record, identification, name, location.
    Reference(u32, Option<String>, Option<String>, Option<String>),
    Si(NewSi),
    /// A mapped item's transformation operator, by its matrix's twelve
    /// rotation and translation entries (bits, column by column).
    Operator([u64; 12]),
}

/// New records an Add builds that a later Add may reuse, by description.
/// What one Add builds stays `pending` until that Add has built completely.
pub(super) struct Shared<'s> {
    pub(super) committed: &'s HashMap<SharedKey, u32>,
    pub(super) pending: HashMap<SharedKey, u32>,
}

impl Shared<'_> {
    pub(super) fn get_or(&mut self, key: SharedKey, build: impl FnOnce() -> Result<u32, String>) -> Result<u32, String> {
        if let Some(&id) = self.committed.get(&key).or_else(|| self.pending.get(&key)) {
            return Ok(id);
        }
        let id = build()?;
        self.pending.insert(key, id);
        Ok(id)
    }
}

/// A new record, refused when it leaves a slot its schema requires unset.
pub(super) fn new_record(emit: &mut Emit, entity: &str, fields: &[(&str, String)]) -> Result<u32, String> {
    let id = emit.record(entity, fields)?;
    super::require_filled(emit, id)?;
    Ok(id)
}

fn optional(s: &Option<String>) -> String {
    s.as_deref().map_or_else(|| "$".into(), quoted)
}

fn material(emit: &mut Emit, shared: &mut Shared, target: &Target<NewMaterial>) -> Result<u32, String> {
    match target {
        Target::Existing(id) => Ok(*id),
        Target::New(m) => shared.get_or(SharedKey::Material(m.clone()), || {
            new_record(emit, "IFCMATERIAL", &[("Name", quoted(&m.name)), ("Category", optional(&m.category))])
        }),
    }
}

/// The `RelatingMaterial` record for a checked material.
pub(super) fn build_material(emit: &mut Emit, shared: &mut Shared, checked: &CheckedMaterial) -> Result<u32, String> {
    let (name, layers) = match checked {
        CheckedMaterial::One(target) => return material(emit, shared, target),
        CheckedMaterial::LayerSet { name, layers } => (name, layers),
    };
    let mut resolved = Vec::with_capacity(layers.len());
    for (m, thickness) in layers {
        resolved.push((m.as_ref().map(|m| material(emit, shared, m)).transpose()?, thickness.to_bits()));
    }
    shared.get_or(SharedKey::LayerSet(name.clone(), resolved.clone()), || {
        let mut layer_ids = Vec::with_capacity(resolved.len());
        for &(m, thickness) in &resolved {
            let fields = [("Material", ref_or_unset(m)), ("LayerThickness", fmt(f64::from_bits(thickness)))];
            layer_ids.push(new_record(emit, "IFCMATERIALLAYER", &fields)?);
        }
        new_record(emit, "IFCMATERIALLAYERSET", &[("MaterialLayers", ref_list(&layer_ids)), ("LayerSetName", optional(name))])
    })
}

/// The `RelatingClassification` record for a checked classification.
pub(super) fn build_classification(emit: &mut Emit, shared: &mut Shared, checked: &CheckedClassification) -> Result<u32, String> {
    let (system, identification, name, location) = match checked {
        CheckedClassification::Existing(id) => return Ok(*id),
        CheckedClassification::New { system, identification, name, location } => (system, identification, name, location),
    };
    let system = match system {
        Target::Existing(id) => *id,
        Target::New(s) => shared.get_or(SharedKey::Classification(s.clone()), || {
            new_record(
                emit,
                "IFCCLASSIFICATION",
                &[("Source", optional(&s.source)), ("Edition", optional(&s.edition)), ("Name", quoted(&s.name))],
            )
        })?,
    };
    let key = SharedKey::Reference(system, identification.clone(), name.clone(), location.clone());
    shared.get_or(key, || {
        // IFC2X3 calls the identification ItemReference.
        let ident_attr = if attribute_index(emit.schema, "IFCCLASSIFICATIONREFERENCE", "Identification").is_some() {
            "Identification"
        } else {
            "ItemReference"
        };
        new_record(
            emit,
            "IFCCLASSIFICATIONREFERENCE",
            &[
                ("Location", optional(location)),
                (ident_attr, optional(identification)),
                ("Name", optional(name)),
                ("ReferencedSource", format!("#{system}")),
            ],
        )
    })
}

/// Request the material and classification relationships of `object`,
/// building whatever new records they name.
pub(super) fn associate(
    emit: &mut Emit,
    shared: &mut Shared,
    c: &super::check::Checked,
    object: u32,
    gid: GlobalId,
    requests: &mut Vec<RelRequest>,
) -> Result<(), String> {
    if let Some(m) = &c.material {
        let relating = build_material(emit, shared, m)?;
        requests.push(RelRequest { kind: RelKind::AssociatesMaterial, relating, related: object, seed: gid });
    }
    for (n, cl) in c.classifications.iter().enumerate() {
        let relating = build_classification(emit, shared, cl)?;
        // A new relationship takes its GlobalId from its first object's
        // seed, so one object's classifications need distinct seeds.
        let seed = gid.derive(&format!("classification/{n}"));
        requests.push(RelRequest { kind: RelKind::AssociatesClassification, relating, related: object, seed });
    }
    Ok(())
}
