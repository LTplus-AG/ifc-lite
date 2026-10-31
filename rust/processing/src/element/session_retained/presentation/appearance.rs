// SPDX-License-Identifier: MPL-2.0
//! M11-A IfcAppearance. A product discharges the obligation only when every
//! part resolves through exact's own colour resolver. A texture or indexed palette
//! binding is flagged here and answered by the surface slice, or refuses there.
use super::appearance_resolve::{bind, resolve_parts, unsupported, Bound, PartSource};
use super::{Context, OwnedMeshProductionContext, RetainedProductPlan, Requirement, ShapeOnlyProduct};
use crate::element::assembly_job::AssemblyJob;
use crate::element::session_retained::error::RetainedExecutionError as Error;
use crate::element::session_retained::publication::PartAppearance;
use crate::element::session_retained::RetainedContextError;
use crate::element::{ElementJobKind, ElementMeshJob, MeshProductionContext, OwnedMeshProductionData, ProductionModel};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType, SourceBundle};
use std::sync::Arc;
use ifc_lite_geometry::resource::Cost;

pub(super) fn apply(product: &mut ShapeOnlyProduct, context: &Context<'_>) -> Result<Vec<Requirement>, Error> {
    let appearances = resolve_plan(context.model, product.product_id, &product.ifc_type, context.plan, context.element_color)?;
    if appearances.len() != product.parts.len() {
        return Err(unsupported(product.product_id, "binding"));
    }
    for appearance in &appearances {
        let name = appearance.material_name.as_ref().map_or(0, String::len);
        let live_bytes = (std::mem::size_of::<PartAppearance>() + name) as u64;
        product._storage.charge(context.resources, Cost { work: 1, live_bytes, ..Default::default() })?;
    }
    for (part, mut appearance) in product.parts.iter_mut().zip(appearances) {
        if context.layer_class != 0 { appearance.geometry_class = context.layer_class; }
        part.appearance = Some(appearance);
    }
    Ok(vec![Requirement::IfcAppearance])
}

/// The appearance of every part of `plan`, in part order, from the source the model snapshot owns. This is
/// everything `apply` does except charging and assigning, so it needs no kernel and no mesh.
fn resolve_plan(
    model: &OwnedMeshProductionContext,
    product_id: u32,
    ifc_type: &IfcType,
    plan: &RetainedProductPlan,
    element_color: [f32; 4],
) -> Result<Vec<PartAppearance>, Error> {
    let source = model.source().ok_or(Error::Source(RetainedContextError::Missing))?;
    let parts: Vec<Bound> = plan.values().enumerate().map(|(index, value)| {
        let mut part = bind(&value.presentation().collect::<Vec<_>>())?;
        if let Some(layers) = plan.layers() { part.source = PartSource::Material(layers.tags[index].material_id); }
        Ok(part)
    }).collect::<Result<_, Error>>()?;
    let mut decoder = source.decoder();
    let entity = decoder.decode_by_id(product_id).map_err(Error::Core)?;
    let job = ElementMeshJob { id: product_id, ifc_type: ifc_type.clone(), entity: &entity,
        kind: ElementJobKind::Product, element_color: None, metadata: None };
    let ctx = model.borrowed();
    let element_color = if parts.iter().any(|part| part.fact.type_product.is_some()) {
        element_color
    } else {
        product_element_color(&entity, &ctx, &mut decoder, element_color)
    };
    resolve_parts(&AssemblyJob::from(&job), &parts, element_color, &ctx, &mut decoder)
}

/// Qualification seam: [`resolve_plan`] over a source and its model maps, with no kernel. A witness walks a real
/// plan from source, hands it the maps the prepass resolved, and compares each part with a hand-authored colour.
pub fn resolve_appearances(
    source: &Arc<SourceBundle>,
    data: OwnedMeshProductionData,
    product_id: u32,
    ifc_type: &IfcType,
    plan: &RetainedProductPlan,
    element_color: [f32; 4],
) -> Result<Vec<PartAppearance>, Error> {
    resolve_plan(&ProductionModel::from_source(source.clone()).snapshot(data), product_id, ifc_type, plan, element_color)
}

/// The fallback colour exact's job carries for a product: the first style found under its representation, else
/// the material chain's fallback, else the class default. The plan cannot supply it (a retained job is built
/// with `element_color: None`, so `ElementPlan` holds only the class default), so this composes it through
/// the precedence exact's job resolver (`processor::job::AppearanceResolver::resolve`) and the authoring
/// pipeline (`appearance::canonical::produce_with_context`) share: `processor::resolve_product_element_color`.
fn product_element_color(
    entity: &DecodedEntity,
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
    default: [f32; 4],
) -> [f32; 4] {
    crate::processor::resolve_product_element_color(entity.ref_at(slot::IfcProduct::REPRESENTATION), entity.id,
        ctx.geometry_style_index, ctx.element_material_colors, decoder)
        .unwrap_or(default)
}

#[cfg(test)]
#[path = "appearance_tests.rs"]
mod tests;
