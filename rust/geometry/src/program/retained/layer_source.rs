// SPDX-License-Identifier: MPL-2.0
//! Bounded source-only family selection; no geometry kernel is entered here.
use super::layer_family::LayerFamily;
use crate::representation::{product_shape, Select};
use crate::trimmed_curve::{decode_trimmed_primitive, TrimRecovery, TrimmedPrimitive};
use ifc_lite_core::{DecodedEntity, EntityDecoder, EntityScanner, IfcType};
const FAMILY: &str = "layer_axis_family";

pub(super) fn usage_id(id: u32, decoder: &mut EntityDecoder) -> Result<u32, &'static str> {
    let source = decoder.trusted_inputs().ok_or("layer_source")?.source().clone();
    let mut scanner = EntityScanner::new(source.bytes());
    let mut selected = None;
    while let Some((entity_id, kind, _, _)) = scanner.next_entity() {
        crate::resource::budget_checkpoint().map_err(|_| "layer_budget")?;
        if !ifc_lite_core::keyword_eq(kind, "IFCRELASSOCIATESMATERIAL") { continue; }
        let association = decoder.decode_by_id(entity_id).map_err(|_| "layer_usage")?;
        if !association.get_list(4).is_some_and(|ids| ids.iter().any(|v| v.as_entity_ref() == Some(id))) { continue; }
        let material = decoder.decode_by_id(association.get_ref(5).ok_or("layer_usage")?).map_err(|_| "layer_usage")?;
        // The canonical material index inserts in source order: the last
        // association wins. Keep cutter provenance tied to that same usage.
        if material.ifc_type == IfcType::IfcMaterialLayerSetUsage { selected = Some(material.id); }
    }
    selected.ok_or("layer_usage")
}
pub(super) fn axis_family(element: &DecodedEntity, decoder: &mut EntityDecoder, scale: f64)
    -> Result<LayerFamily, &'static str> {
    let shape = product_shape(element, decoder).map_err(|_| FAMILY)?.ok_or(FAMILY)?;
    // CUT-0 has no Select::Axis variant; use the canonical selector's predicate.
    let mut axes = shape.select(element, Select::Where(|_, rep, _| rep.get_string(1) == Some("Axis")));
    let Some(rep) = axes.next() else { return line_body(element, decoder); };
    if axes.next().is_some() { return Err(FAMILY); }
    let items = rep.get_list(3).ok_or(FAMILY)?;
    if items.len() != 1 { return Err(FAMILY); }
    let axis = decoder.decode_by_id(items[0].as_entity_ref().ok_or(FAMILY)?).map_err(|_| FAMILY)?;
    if axis.ifc_type == IfcType::IfcPolyline {
        let ids = axis.get_list(0).ok_or(FAMILY)?;
        if ids.len() != 2 { return Err(FAMILY); }
        let a = decoder.point3(ids[0].as_entity_ref().ok_or(FAMILY)?).map_err(|_| FAMILY)?;
        let b = decoder.point3(ids[1].as_entity_ref().ok_or(FAMILY)?).map_err(|_| FAMILY)?;
        if a == b { return Err(FAMILY); }
        return Ok(LayerFamily::Planar { axis: [0., 1., 0.] });
    }
    if axis.ifc_type != IfcType::IfcTrimmedCurve { return Err(FAMILY); }
    let basis = decoder.decode_by_id(axis.get_ref(0).ok_or(FAMILY)?).map_err(|_| FAMILY)?;
    let trimmed = decode_trimmed_primitive(&axis, &basis, decoder, TrimRecovery::RequireBoth)
        .map_err(|_| FAMILY)?.ok_or(FAMILY)?;
    match trimmed {
        TrimmedPrimitive::Line { start, end } if start != end => Ok(LayerFamily::Planar { axis: [0., 1., 0.] }),
        TrimmedPrimitive::Circle { center, normal, radius, .. } => {
            let placement = decoder.decode_by_id(basis.get_ref(0).ok_or(FAMILY)?).map_err(|_| FAMILY)?;
            if rep.get_string(2) != Some("Curve2D") || placement.ifc_type != IfcType::IfcAxis2Placement2D
                || normal != [0., 0., 1.] { return Err(FAMILY); }
            let sigma = if axis.get_bool(3).ok_or(FAMILY)? { 1. } else { -1. };
            Ok(LayerFamily::Cylindrical { center: center.map(|v| v * scale), radius: radius * scale, sigma })
        }
        _ => Err(FAMILY),
    }
}
fn line_body(element: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<LayerFamily, &'static str> {
    let shape = product_shape(element, decoder).map_err(|_| FAMILY)?.ok_or(FAMILY)?;
    let rep = shape.select(element, Select::Body).next().ok_or(FAMILY)?;
    let items = rep.get_list(3).ok_or(FAMILY)?;
    let mut id = items.first().and_then(|v| v.as_entity_ref()).ok_or(FAMILY)?;
    let mut visited = rustc_hash::FxHashSet::default();
    loop {
        crate::resource::budget_checkpoint().map_err(|_| "layer_budget")?;
        if !visited.insert(id) { return Err(FAMILY); }
        let item = decoder.decode_by_id(id).map_err(|_| FAMILY)?;
        if matches!(item.ifc_type, IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult) {
            id = item.get_ref(1).ok_or(FAMILY)?; continue;
        }
        if item.ifc_type != IfcType::IfcExtrudedAreaSolid { return Err(FAMILY); }
        let source = crate::analytic::try_extract_analytic_extrusion(&item, decoder).map_err(|_| FAMILY)?;
        if source.status != crate::analytic::AnalyticStatus::Complete { return Err(FAMILY); }
        let profile = source.profile.ok_or(FAMILY)?;
        if profile.status != crate::analytic::AnalyticStatus::Complete || profile.loops.is_empty() { return Err(FAMILY); }
        if profile.loops.iter().flat_map(|l| &l.segments)
            .any(|s| !matches!(s, crate::analytic::AnalyticCurveSegment::Line { .. })) { return Err(FAMILY); }
        return Ok(LayerFamily::Planar { axis: [0., 1., 0.] });
    }
}
