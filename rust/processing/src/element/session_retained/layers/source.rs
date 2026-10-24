// SPDX-License-Identifier: MPL-2.0
//! Authored order, units and optional material bindings, without visual merging.
use super::*;
pub(super) fn capture(context: &OwnedMeshProductionContext, product: &DecodedEntity,
    association: u32, usage: &DecodedEntity, decoder: &mut EntityDecoder, router: &GeometryRouter)
    -> Result<RetainedLayerSource, RetainedExecutionError> {
    let axis = match usage.get(1).and_then(AttributeValue::as_enum) {
        Some("AXIS1") => LayerAxis::Axis1, Some("AXIS2") => LayerAxis::Axis2,
        Some("AXIS3") => LayerAxis::Axis3, _ => return Err(invalid()),
    };
    let direction = match usage.get(2).and_then(AttributeValue::as_enum) {
        Some("POSITIVE") => 1., Some("NEGATIVE") => -1., _ => return Err(invalid()),
    };
    let unit_scale = router.unit_scale();
    let offset = usage.get_float(3).ok_or_else(invalid)?;
    if !unit_scale.is_finite() || unit_scale <= 0. || !offset.is_finite() { return Err(invalid()); }
    let layer_set = decode(decoder, usage.get_ref(0).ok_or_else(invalid)?)?;
    if layer_set.ifc_type != IfcType::IfcMaterialLayerSet { return Err(invalid()); }
    let members = layer_set.get_list(0).ok_or_else(invalid)?;
    if members.is_empty() { return Err(invalid()); }
    charge(members.len())?;
    let mut bands = Vec::new();
    let mut interfaces = Vec::new();
    reserve(&mut bands, members.len())?;
    reserve(&mut interfaces, members.len() - 1)?;
    let mut boundary = offset * unit_scale;
    if !boundary.is_finite() { return Err(invalid()); }
    for (ordinal, member) in members.iter().enumerate() {
        let layer = decode(decoder, reference_id(member)?)?;
        if layer.ifc_type != IfcType::IfcMaterialLayer { return Err(invalid()); }
        let thickness = layer.get_float(1).ok_or_else(invalid)? * unit_scale;
        if !thickness.is_finite() || thickness <= 0. { return Err(invalid()); }
        let end = boundary + direction * thickness;
        // Overflow and sub-ULP bands are not positive geometric thicknesses.
        if !end.is_finite() || direction * (end - boundary) <= 0. { return Err(invalid()); }
        let material_id = match layer.get(0).ok_or_else(invalid)? {
            AttributeValue::Null => None,
            value => {
                let id = reference_id(value)?;
                if decode(decoder, id)?.ifc_type != IfcType::IfcMaterial { return Err(invalid()); }
                Some(id)
            }
        };
        bands.push(RetainedLayerBand { layer_id: layer.id, material_id, ordinal,
            thickness_metres: thickness, start_metres: boundary, end_metres: end });
        if ordinal > 0 { interfaces.push(RetainedLayerInterface {
            usage_id: usage.id, before_band: ordinal - 1, after_band: ordinal }); }
        boundary = end;
    }
    let reference = reference(product, axis, decoder)?;
    let placement = router.resolve_scaled_placement_strict(product, decoder).map_err(geometry)?;
    if placement.iter().any(|v| !v.is_finite()) { return Err(invalid()); }
    let mut world_from_product = [0.; 16];
    world_from_product.copy_from_slice(placement.as_slice());
    Ok(RetainedLayerSource { context: context.id(), product: product.id, association, usage: usage.id,
        layer_set: layer_set.id, axis, direction, unit_scale, reference, bands, interfaces, world_from_product })
}
fn reference(product: &DecodedEntity, axis: LayerAxis, decoder: &mut EntityDecoder)
    -> Result<RetainedLayerReference, RetainedExecutionError> {
    if !product.ifc_type.is_subtype_of(IfcType::IfcWall) {
        return Ok(RetainedLayerReference::ProductAxis(axis));
    }
    // IFC wall usage follows the Axis curve. Its offset construction is a
    // separate numerical prerequisite; curved Axis2 must not become a Y slab.
    if axis != LayerAxis::Axis2 { return Err(invalid()); }
    let shape = decode(decoder, product.get_ref(ifc_lite_core::slot::IfcProduct::REPRESENTATION.index())
        .ok_or_else(invalid)?)?;
    if shape.ifc_type != IfcType::IfcProductDefinitionShape { return Err(invalid()); }
    let representations = shape.get_list(2).ok_or_else(invalid)?;
    charge(representations.len())?;
    let mut axis_reference = None;
    for item in representations {
        let representation = decode(decoder, reference_id(item)?)?;
        if representation.ifc_type != IfcType::IfcShapeRepresentation { return Err(invalid()); }
        if representation.get_string(1) != Some("Axis") { continue; }
        let items = representation.get_list(3).ok_or_else(invalid)?;
        if items.len() != 1 || axis_reference.is_some() { return Err(invalid()); }
        let curve = decode(decoder, reference_id(&items[0])?)?;
        if !curve.ifc_type.is_subtype_of(IfcType::IfcCurve) { return Err(invalid()); }
        axis_reference = Some(RetainedLayerReference::WallAxis {
            representation_id: representation.id, curve_id: curve.id });
    }
    axis_reference.ok_or_else(invalid)
}
