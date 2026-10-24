// SPDX-License-Identifier: MPL-2.0
//! Mapped bodies for [`super::super::Disposition::Add`]: a type's geometry
//! written once as an `IfcRepresentationMap`, and occurrences that instance
//! it through `IfcMappedItem` instead of carrying a copy each. A child of
//! `add`, which builds through it.
//!
//! The maps an occurrence instances are its type's `Body` maps: the ones a
//! type in the source already has, or the one this plan writes for a new
//! type with a representation. Each map keeps the representation context it
//! was written in, so an occurrence gets one `MappedRepresentation` per
//! context, as its type's own geometry would.

use std::rc::Rc;

use crate::plan::add_geometry::body_representation_of;
use crate::plan::add_types::{NewObject, Representation, TypeLink};
use crate::plan::props_lookup::{list_attr, scalar_attr};
use crate::plan::props_synth::ref_list;
use crate::plan::tessellation::Emit;
use crate::plan::types::{ObjectRef, SurfaceColour};

use super::assoc::{Shared, SharedKey};
use super::AddState;

/// A representation map, and the context of the representation it maps.
pub(super) type MapRef = (u32, u32);

/// Where a mapped body's maps come from.
pub(super) enum MapPlan {
    /// A type that already has them: in the source, or added earlier in the plan.
    Existing(Rc<[MapRef]>),
    /// The new type the same Add creates, whose map it writes.
    NewType,
}

impl AddState<'_> {
    /// Refuse a mapped body this Add cannot build: a transform that is not
    /// a rotation and a translation, an own colour, or a type without a
    /// `Body` map.
    pub(super) fn check_mapped(&self, obj: &NewObject, existing_type: Option<u32>) -> Result<Option<MapPlan>, String> {
        let Representation::Mapped(m) = &obj.representation else { return Ok(None) };
        crate::plan::placement::check_matrix(&m.transform).map_err(|e| format!("mapped body: {e}"))?;
        if obj.style.is_some() {
            return Err("a mapped body takes its type's colour, not its own".into());
        }
        match (&obj.type_link, existing_type) {
            (Some(TypeLink::New(t)), _) if !matches!(t.representation, Representation::None) => Ok(Some(MapPlan::NewType)),
            (Some(TypeLink::New(_)), _) => Err("a mapped body needs its new type to have a representation".into()),
            (Some(TypeLink::Existing(r)), Some(id)) => self.type_maps_of(id, r).map(|maps| Some(MapPlan::Existing(maps))),
            _ => Err("a mapped body needs a type to map".into()),
        }
    }

    /// The `Body` maps of type `id`: the ones this plan wrote for it, else
    /// the ones it has in the source (read once per type), skipping any this
    /// plan deletes. Adds run after every delete has settled, so the answer
    /// does not change during them.
    fn type_maps_of(&self, id: u32, what: &ObjectRef) -> Result<Rc<[MapRef]>, String> {
        if let Some(maps) = self.type_maps.get(&id).or(self.source_maps.borrow().get(&id)) {
            return Ok(maps.clone());
        }
        let maps = if self.index.contains(id) { self.source_type_maps(id) } else { Vec::new() };
        if maps.is_empty() {
            return Err(format!("type {what} has no Body representation map"));
        }
        let maps: Rc<[MapRef]> = maps.into();
        self.source_maps.borrow_mut().insert(id, maps.clone());
        Ok(maps)
    }

    fn source_type_maps(&self, id: u32) -> Vec<MapRef> {
        let (schema, index) = (self.schema, self.index);
        let live = |r: &u32| !self.removed.contains(r);
        let entity = |r: u32| index.type_of(r).unwrap_or_default();
        let maps = list_attr(index, schema, id, &entity(id), "RepresentationMaps").unwrap_or_default();
        let mut out = Vec::new();
        for map in maps.into_iter().filter(live) {
            let Some(rep) = scalar_attr(index, schema, map, &entity(map), "MappedRepresentation").filter(live) else { continue };
            let rep_entity = entity(rep);
            if index.string_attr(schema, rep, &rep_entity, "RepresentationIdentifier").as_deref() != Some("Body") {
                continue;
            }
            if let Some(context) = scalar_attr(index, schema, rep, &rep_entity, "ContextOfItems").filter(live) {
                out.push((map, context));
            }
        }
        out
    }
}

/// A type's `representation` as one `IfcRepresentationMap` at the type's
/// own origin, in `context`; none when it has no geometry.
pub(super) fn build_map(emit: &mut Emit, context: u32, rep: &Representation, style: Option<&SurfaceColour>) -> Result<Vec<MapRef>, String> {
    let Some(mapped) = body_representation_of(emit, context, rep, style)? else { return Ok(Vec::new()) };
    let origin = emit.identity_placement()?;
    let map = emit.record("IFCREPRESENTATIONMAP", &[("MappingOrigin", format!("#{origin}")), ("MappedRepresentation", format!("#{mapped}"))])?;
    Ok(vec![(map, context)])
}

/// An occurrence's `IfcProductDefinitionShape` instancing `maps` at
/// `transform`: one `IfcMappedItem` per map, in one `MappedRepresentation`
/// per context. Occurrences at the same transform share one operator.
pub(super) fn mapped_shape(emit: &mut Emit, shared: &mut Shared, maps: &[MapRef], transform: &[[f64; 4]; 4]) -> Result<u32, String> {
    let operator = transformation_operator(emit, shared, transform)?;
    let mut contexts: Vec<u32> = Vec::new();
    for &(_, context) in maps {
        if !contexts.contains(&context) {
            contexts.push(context);
        }
    }
    let mut reps = Vec::with_capacity(contexts.len());
    for context in contexts {
        let mut items = Vec::new();
        for &(map, _) in maps.iter().filter(|(_, c)| *c == context) {
            items.push(emit.record("IFCMAPPEDITEM", &[("MappingSource", format!("#{map}")), ("MappingTarget", format!("#{operator}"))])?);
        }
        reps.push(emit.record(
            "IFCSHAPEREPRESENTATION",
            &[
                ("ContextOfItems", format!("#{context}")),
                ("RepresentationIdentifier", "'Body'".into()),
                ("RepresentationType", "'MappedRepresentation'".into()),
                ("Items", ref_list(&items)),
            ],
        )?);
    }
    emit.record("IFCPRODUCTDEFINITIONSHAPE", &[("Representations", ref_list(&reps))])
}

/// An `IfcCartesianTransformationOperator3D` for a checked rigid
/// `transform`: its axes are the matrix's columns, its origin the
/// translation, its scale 1.
fn transformation_operator(emit: &mut Emit, shared: &mut Shared, m: &[[f64; 4]; 4]) -> Result<u32, String> {
    let column = |c: usize| [m[0][c], m[1][c], m[2][c]];
    let key = SharedKey::Operator(std::array::from_fn(|i| m[i % 3][i / 3].to_bits()));
    shared.get_or(key, || {
        let (x, y, z) = (emit.direction(column(0))?, emit.direction(column(1))?, emit.direction(column(2))?);
        let origin = emit.point(column(3))?;
        emit.record(
            "IFCCARTESIANTRANSFORMATIONOPERATOR3D",
            &[
                ("Axis1", format!("#{x}")),
                ("Axis2", format!("#{y}")),
                ("LocalOrigin", format!("#{origin}")),
                ("Scale", "1.".into()),
                ("Axis3", format!("#{z}")),
            ],
        )
    })
}

#[cfg(test)]
#[path = "add_mapped_tests.rs"]
mod tests;
