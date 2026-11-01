// SPDX-License-Identifier: MPL-2.0
//! M11-I: optional view sharing, never a discharged presentation obligation.
use super::{ShapeOnlyProduct, Context, Requirement};
use crate::element::{assembly_job::AssemblyJob, ElementMeshJob, ElementJobKind};
use ifc_lite_geometry::resource;
use super::super::publication::ShapePart;
#[path = "instancing_key.rs"]
mod key;

pub(super) fn apply(product: &mut ShapeOnlyProduct, context: &Context<'_>) -> Vec<Requirement> {
    if context.layer_class != 0 || product.parts.len() != 1 || product.cuts != 0 || product.parts.iter().any(|p| p.surface.is_some() || p.layer.is_some()) || context.plan.values().len() != 1 {
        return Vec::new();
    }
    let value = context.plan.values().next().expect("one value");
    let Some(map) = value.instance_representation_map() else { return Vec::new() };
    let Some(source) = context.model.source() else { return Vec::new() };
    let mut decoder = source.decoder().with_strict_reals();
    let Ok(entity) = decoder.decode_by_id(product.product_id) else { return Vec::new() };
    let job = ElementMeshJob { id: product.product_id, ifc_type: product.ifc_type.clone(),
        entity: &entity, kind: ElementJobKind::Product, element_color: Some(context.element_color), metadata: None };
    let model = context.model.borrowed();
    let Some((item, _, _)) = value.bindings().next() else { return Vec::new() };
    let (rgba, _) = crate::element::presentation_source::color(&AssemblyJob::from(&job), item,
        context.element_color, model.element_material_colors.get(&product.product_id).map(Vec::as_slice),
        &mut 0, &model, &mut decoder, false);
    let part = &mut product.parts[0];
    let rgba = part.appearance.as_ref().map_or(rgba, |p| p.rgba);
    if rgba[3] < 0.99 || !rgba[3].is_finite()
        || part.appearance.as_ref().is_some_and(|p| p.geometry_class != 0 || p.material_id.is_some()) {
        return Vec::new();
    }
    // Hashing streams bytes without another mesh allocation. Budget exhaustion
    // latches the product stop; publication's final validate prevents emission.
    if resource::charge(resource::Cost { work: (part.positions.len() + part.indices.len()
        + part.normals.as_ref().map_or(0, Vec::len)
        + part.faces.as_ref().map_or(0, |f| f.triangles.len() + f.table.len())) as u64,
        ..Default::default() }).is_err() { return Vec::new(); }
    part.instance_key = Some(key::instance_key(map, part));
    Vec::new()
}
