// SPDX-License-Identifier: MPL-2.0
//! Reused bodies for [`super::super::Disposition::Add`]: a new product with
//! every representation of a product already in the source, not only its
//! body. A child of `add`, which builds through it. Openings that void the
//! source, its projections and the layer assignments of its representations
//! are not carried; an Add that needs openings declares its own.
//!
//! The new product gets its own `IfcProductDefinitionShape` and its own
//! representations, one per representation of the source product, in the
//! same context with the same identifier and type, listing the source's own
//! items. Items are positioned relative to the object placement, so at its
//! own placement the new product shows the same geometry, and a style or a
//! layer assignment on an item applies to both. The shape itself is not
//! shared: IFC2X3's inverse `ShapeOfProduct` allows one product per shape.

use crate::plan::add_types::{NewObject, Representation};
use crate::plan::attrs::attribute_index;
use crate::plan::props_lookup::{list_attr, scalar_attr};
use crate::plan::props_synth::ref_list;
use crate::plan::tessellation::Emit;

use super::AddState;

/// One representation of the source product, as the new product repeats it.
pub(super) struct ReusedRepresentation {
    entity: String,
    context: u32,
    /// `RepresentationIdentifier` and `RepresentationType` as the source
    /// writes them.
    identifier: String,
    rep_type: String,
    items: Vec<u32>,
}

impl AddState<'_, '_> {
    /// The representations a [`Representation::SameAs`] object repeats, or
    /// why it cannot: the source is not a live product of the source file,
    /// has no representation, gets new geometry from a patch, or loses part
    /// of a representation to this plan's deletes.
    pub(super) fn check_same_as(&self, obj: &NewObject) -> Result<Option<Vec<ReusedRepresentation>>, String> {
        let Representation::SameAs(source) = &obj.representation else { return Ok(None) };
        if obj.style.is_some() {
            return Err("reused geometry keeps its source's colour, not its own".into());
        }
        let (id, class) = self.lookup(source).map_err(|e| format!("representation source: {e}"))?;
        if !self.index.contains(id) {
            return Err(format!("representation source {source} is added by this plan; only a product in the source can lend its geometry"));
        }
        if !self.is_a(&class, "IFCPRODUCT") {
            return Err(format!("representation source {source} is {class}, not a product"));
        }
        if self.reshaped.contains(&id) {
            return Err(format!("representation source {source} gets new geometry from a patch in this plan; reuse its mesh instead"));
        }
        let (index, schema) = (self.index, self.schema);
        let entity = |r: u32| index.type_of(r).unwrap_or_default();
        let shape = scalar_attr(index, schema, id, &class, "Representation");
        let reps = shape.and_then(|s| list_attr(index, schema, s, &entity(s), "Representations")).unwrap_or_default();
        if reps.is_empty() {
            return Err(format!("representation source {source} has no representation"));
        }
        let mut out = Vec::with_capacity(reps.len());
        for rep in reps {
            let at = || format!("representation source {source}: representation #{rep}");
            let e = entity(rep);
            let Some(context) = scalar_attr(index, schema, rep, &e, "ContextOfItems").filter(|c| index.contains(*c)) else {
                return Err(format!("{} has no readable context", at()));
            };
            if self.removed.contains(&context) {
                return Err(format!("{} is in a context this plan removes", at()));
            }
            if self.removed.contains(&rep) {
                return Err(format!("{} is removed by this plan", at()));
            }
            let items = list_attr(index, schema, rep, &e, "Items").unwrap_or_default();
            if items.is_empty() {
                return Err(format!("{} has no items", at()));
            }
            if let Some(item) = items.iter().find(|i| !index.contains(**i) || self.removed.contains(i)) {
                let why = if index.contains(*item) { "is removed by this plan" } else { "is not in the source" };
                return Err(format!("{}: item #{item} {why}", at()));
            }
            let line = index.raw_line(rep).unwrap_or_default();
            let raw = |attr| crate::step_text::attribute_of(&line, attribute_index(schema, &e, attr)?);
            let (Some(identifier), Some(rep_type)) = (raw("RepresentationIdentifier"), raw("RepresentationType")) else {
                return Err(format!("{} does not scan", at()));
            };
            out.push(ReusedRepresentation { entity: e, context, identifier, rep_type, items });
        }
        Ok(Some(out))
    }
}

/// The new product's `IfcProductDefinitionShape`: one representation per
/// checked source representation, listing the source's items.
pub(super) fn reused_shape(emit: &mut Emit, reps: &[ReusedRepresentation]) -> Result<u32, String> {
    let mut ids = Vec::with_capacity(reps.len());
    for r in reps {
        ids.push(emit.record(
            &r.entity,
            &[
                ("ContextOfItems", format!("#{}", r.context)),
                ("RepresentationIdentifier", r.identifier.clone()),
                ("RepresentationType", r.rep_type.clone()),
                ("Items", ref_list(&r.items)),
            ],
        )?);
    }
    emit.record("IFCPRODUCTDEFINITIONSHAPE", &[("Representations", ref_list(&ids))])
}

#[cfg(test)]
#[path = "add_same_as_tests.rs"]
mod tests;
