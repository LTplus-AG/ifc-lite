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

use crate::plan::add_geometry::body_representation_of;
use crate::plan::add_types::{NewObject, Representation, TypeLink};
use crate::plan::attrs::attribute_index;
use crate::plan::placement::fmt;
use crate::plan::props_synth::ref_list;
use crate::plan::tessellation::Emit;
use crate::plan::types::{ObjectRef, SurfaceColour};

use super::AddState;

/// A representation map, and the context of the representation it maps.
pub(super) type MapRef = (u32, u32);

/// Where a mapped body's maps come from.
pub(super) enum MapPlan {
    /// A type that already has them: in the source, or added earlier in the plan.
    Existing(Vec<MapRef>),
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
    /// the ones it has in the source, skipping any this plan deletes.
    fn type_maps_of(&self, id: u32, what: &ObjectRef) -> Result<Vec<MapRef>, String> {
        if let Some(maps) = self.type_maps.get(&id) {
            return Ok(maps.clone());
        }
        let none = || format!("type {what} has no Body representation map");
        if !self.index.contains(id) {
            return Err(none());
        }
        let (schema, index) = (self.schema, self.index);
        let live = |r: u32| !self.removed.contains(&r);
        let slot = |record: u32, attr: &str| {
            let entity = index.type_of(record)?;
            let i = attribute_index(schema, &entity, attr)?;
            index.attrs(record)?.into_iter().nth(i)
        };
        let maps: Vec<u32> = slot(id, "RepresentationMaps").and_then(|a| a.list).unwrap_or_default().into_iter().flatten().filter(|&m| live(m)).collect();
        let mut out = Vec::new();
        for map in maps {
            let Some(rep) = slot(map, "MappedRepresentation").and_then(|a| a.scalar).filter(|&r| live(r)) else { continue };
            let entity = index.type_of(rep).unwrap_or_default();
            if index.string_attr(schema, rep, &entity, "RepresentationIdentifier").as_deref() != Some("Body") {
                continue;
            }
            if let Some(context) = slot(rep, "ContextOfItems").and_then(|a| a.scalar).filter(|&c| live(c)) {
                out.push((map, context));
            }
        }
        if out.is_empty() {
            return Err(none());
        }
        Ok(out)
    }
}

/// A type's `representation` as one `IfcRepresentationMap` at the type's
/// own origin, in `context`; `None` when it has none.
pub(super) fn build_map(emit: &mut Emit, context: u32, rep: &Representation, style: Option<&SurfaceColour>) -> Result<Option<MapRef>, String> {
    let Some(mapped) = body_representation_of(emit, context, rep, style)? else { return Ok(None) };
    let origin = emit.identity_placement()?;
    let map = emit.record("IFCREPRESENTATIONMAP", &[("MappingOrigin", format!("#{origin}")), ("MappedRepresentation", format!("#{mapped}"))])?;
    Ok(Some((map, context)))
}

/// An occurrence's `IfcProductDefinitionShape` instancing `maps` at
/// `transform`: one `IfcMappedItem` per map, sharing one transformation
/// operator, in one `MappedRepresentation` per context.
pub(super) fn mapped_shape(emit: &mut Emit, maps: &[MapRef], transform: &[[f64; 4]; 4]) -> Result<u32, String> {
    let operator = transformation_operator(emit, transform)?;
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
fn transformation_operator(emit: &mut Emit, m: &[[f64; 4]; 4]) -> Result<u32, String> {
    let column = |c: usize| [m[0][c], m[1][c], m[2][c]];
    let mut direction = |v: [f64; 3]| emit.record("IFCDIRECTION", &[("DirectionRatios", format!("({},{},{})", fmt(v[0]), fmt(v[1]), fmt(v[2])))]);
    let (x, y, z) = (direction(column(0))?, direction(column(1))?, direction(column(2))?);
    let t = column(3);
    let origin = emit.record("IFCCARTESIANPOINT", &[("Coordinates", format!("({},{},{})", fmt(t[0]), fmt(t[1]), fmt(t[2])))])?;
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
}

#[cfg(test)]
#[path = "add_mapped_tests.rs"]
mod tests;
