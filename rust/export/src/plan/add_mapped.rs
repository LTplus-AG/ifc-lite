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

/// A type's `Body` maps, or why an occurrence cannot instance them.
pub(super) type TypeMaps = Result<Rc<[MapRef]>, NoBody>;

/// Where a mapped body's maps come from.
pub(super) enum MapPlan {
    /// A type that already has them: in the source, or added earlier in the plan.
    Existing(Rc<[MapRef]>),
    /// The new type the same Add creates, whose map it writes.
    NewType,
}

impl AddState<'_, '_> {
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
    /// the ones it has in the source, read once per type (a refusal too).
    /// Adds run after every delete has settled, so the answer does not
    /// change during them.
    fn type_maps_of(&self, id: u32, what: &ObjectRef) -> Result<Rc<[MapRef]>, String> {
        let cached = self.type_maps.borrow().get(&id).cloned();
        let answer = match cached {
            Some(answer) => answer,
            None => {
                let answer = if self.index.contains(id) { self.source_type_maps(id) } else { Err(NoBody::Missing) };
                self.type_maps.borrow_mut().insert(id, answer.clone());
                answer
            }
        };
        answer.map_err(|why| match why {
            NoBody::Missing => format!("type {what} has no Body representation map"),
            NoBody::Deleted => format!("the Body maps of type {what} are deleted by this plan"),
        })
    }

    /// A source type's `Body` maps, of the best rank that is intact. Maps are
    /// ranked by how plainly they are the body ([`body_rank`]), so a fallback
    /// is not drawn on top of the body it stands in for, but stands in when
    /// this plan deletes part of every body of a better rank. Of one rank,
    /// the maps of one intact context are taken: the plan's body context
    /// when it is one, else the first. A type that keeps one body per level
    /// of detail has a map per context, and an occurrence instances one.
    fn source_type_maps(&self, id: u32) -> Result<Rc<[MapRef]>, NoBody> {
        let (schema, index) = (self.schema, self.index);
        let entity = |r: u32| index.type_of(r).unwrap_or_default();
        let live = |r: &u32| !self.removed.contains(r);
        let maps = list_attr(index, schema, id, &entity(id), "RepresentationMaps").unwrap_or_default();
        // (rank, map, context, every item intact)
        let mut body = Vec::new();
        // The copy instances what the output type keeps. A Body map this
        // plan deletes (directly, or with its origin, representation or
        // context, which take it along) is gone from the type too; it only
        // decides whether a refusal says the body was deleted.
        let mut deleted = false;
        for map in maps {
            let origin = scalar_attr(index, schema, map, &entity(map), "MappingOrigin");
            let Some(rep) = scalar_attr(index, schema, map, &entity(map), "MappedRepresentation") else { continue };
            let Some(rank) = self.body_rank(rep) else { continue };
            let (Some(origin), Some(context)) = (origin, scalar_attr(index, schema, rep, &entity(rep), "ContextOfItems")) else { continue };
            if ![map, origin, rep, context].iter().all(live) {
                deleted = true;
                continue;
            }
            // Items are a list the cascade strips without removing the
            // representation: a map that lost one is unusable, not gone.
            let items = list_attr(index, schema, rep, &entity(rep), "Items").unwrap_or_default();
            if !items.is_empty() {
                body.push((rank, map, context, items.iter().all(live)));
            }
        }
        let mut ranks: Vec<u8> = body.iter().map(|&(rank, ..)| rank).collect();
        ranks.sort_unstable();
        ranks.dedup();
        for rank in ranks {
            let of_rank: Vec<_> = body.iter().filter(|&&(r, ..)| r == rank).collect();
            // A context is usable when every map of this rank in it is intact.
            let intact = |c: u32| of_rank.iter().filter(|&&&(_, _, ctx, _)| ctx == c).all(|&&(.., ok)| ok);
            let contexts = || of_rank.iter().map(|&&(_, _, c, _)| c);
            let chosen = contexts().find(|&c| Some(c) == self.body_context && intact(c)).or_else(|| contexts().find(|&c| intact(c)));
            if let Some(chosen) = chosen {
                return Ok(of_rank.into_iter().filter(|&&(_, _, c, _)| c == chosen).map(|&(_, map, context, _)| (map, context)).collect());
            }
        }
        Err(if body.is_empty() && !deleted { NoBody::Missing } else { NoBody::Deleted })
    }

    /// How plainly representation `rep` is the body, when its
    /// `RepresentationType` is one the geometry engine meshes as a body (or
    /// it has none; `rust/geometry/src/representation/select.rs`): 0 for a
    /// `Body` identifier; 1 for a `Body-FallBack` or `Facetation` one, or
    /// none. `None` for any other identifier (`Clearance`, `Reference`,
    /// `Axis`) or type.
    fn body_rank(&self, rep: u32) -> Option<u8> {
        let entity = self.index.type_of(rep).unwrap_or_default();
        let read = |attr| self.index.string_attr(self.schema, rep, &entity, attr).filter(|s| !s.trim().is_empty());
        let body_type = read("RepresentationType").is_none_or(|t| {
            [
                "Body", "SweptSolid", "Brep", "CSG", "Clipping", "Tessellation", "MappedRepresentation", "SolidModel", "SurfaceModel", "Surface3D",
                "AdvancedSweptSolid", "AdvancedBrep",
            ]
            .contains(&t.as_str())
        });
        if !body_type {
            return None;
        }
        match read("RepresentationIdentifier") {
            None => read("RepresentationType").map(|_| 1),
            Some(id) if id.eq_ignore_ascii_case("Body") => Some(0),
            Some(id) if id.eq_ignore_ascii_case("Body-FallBack") || id.eq_ignore_ascii_case("Facetation") => Some(1),
            Some(_) => None,
        }
    }
}

/// Why a type has no `Body` maps an occurrence can instance.
#[derive(Debug, Clone, Copy)]
pub(super) enum NoBody {
    Missing,
    /// It has some, and this plan deletes part of each.
    Deleted,
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
    // `+ 0.0` folds -0.0 into 0.0, so an identical transform shares a key.
    let key = SharedKey::Operator(std::array::from_fn(|i| (m[i % 3][i / 3] + 0.0).to_bits()));
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
