// SPDX-License-Identifier: MPL-2.0
//! Bounded source-only family selection; no geometry kernel is entered here.
use super::layer_family::LayerFamily;
use crate::representation::{product_shape, Select};
use crate::trimmed_curve::{decode_trimmed_primitive, TrimRecovery, TrimmedPrimitive};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, EntityScanner, IfcType};
use rustc_hash::FxHashMap;
const FAMILY: &str = "layer_axis_family";

/// #7955: element -> layer-set usage, built once per model beside
/// `MaterialLayerIndex`. An element keeps the FIRST sliceable
/// `IfcMaterialLayerSetUsage` association in file order, as exact's
/// `insert_association` keeps the first Sliceable buildup.
#[derive(Debug, Default)]
pub struct LayerUsages(FxHashMap<u32, u32>);
impl LayerUsages {
    pub fn from_content(content: &[u8], decoder: &mut EntityDecoder) -> Self {
        let mut usages = FxHashMap::default();
        let mut scanner = EntityScanner::new(content);
        while let Some((id, kind, _, _)) = scanner.next_entity() {
            if !ifc_lite_core::keyword_eq(kind, "IFCRELASSOCIATESMATERIAL") { continue; }
            let Ok(association) = decoder.decode_by_id(id) else { continue };
            let Some(material) = association.ref_at(slot::IfcRelAssociatesMaterial::RELATING_MATERIAL)
                .and_then(|id| decoder.decode_by_id(id).ok()) else { continue };
            if material.ifc_type != IfcType::IfcMaterialLayerSetUsage
                || !crate::material_layer_index::resolve_retained_buildup(material.id, decoder).is_sliceable() { continue; }
            let Some(related) = association.get_list(slot::IfcRelAssociatesMaterial::RELATED_OBJECTS.index()) else { continue };
            for element in related.iter().filter_map(|v| v.as_entity_ref()) {
                usages.entry(element).or_insert(material.id);
            }
        }
        Self(usages)
    }
    pub(super) fn get(&self, element: u32) -> Result<u32, &'static str> {
        self.0.get(&element).copied().ok_or("layer_usage")
    }
}
pub(super) fn axis_family(element: &DecodedEntity, decoder: &mut EntityDecoder, scale: f64)
    -> Result<LayerFamily, &'static str> {
    let shape = product_shape(element, decoder).map_err(|_| FAMILY)?.ok_or(FAMILY)?;
    // CUT-0 has no Select::Axis variant; use the canonical selector's predicate.
    let mut axes = shape.select(element, Select::Where(|_, rep, _| rep.string_at(slot::IfcRepresentation::REPRESENTATION_IDENTIFIER) == Some("Axis")));
    let Some(rep) = axes.next() else { return line_body(element, decoder); };
    if axes.next().is_some() { return Err(FAMILY); }
    let items = rep.get_list(slot::IfcRepresentation::ITEMS.index()).ok_or(FAMILY)?;
    if items.len() != 1 { return Err(FAMILY); }
    let axis = decoder.decode_by_id(items[0].as_entity_ref().ok_or(FAMILY)?).map_err(|_| FAMILY)?;
    if axis.ifc_type == IfcType::IfcPolyline {
        let ids = axis.get_list(slot::IfcPolyline::POINTS.index()).ok_or(FAMILY)?;
        if ids.len() != 2 { return Err(FAMILY); }
        let a = decoder.point3(ids[0].as_entity_ref().ok_or(FAMILY)?).map_err(|_| FAMILY)?;
        let b = decoder.point3(ids[1].as_entity_ref().ok_or(FAMILY)?).map_err(|_| FAMILY)?;
        if a == b { return Err(FAMILY); }
        return Ok(LayerFamily::Planar { axis: [0., 1., 0.] });
    }
    if axis.ifc_type != IfcType::IfcTrimmedCurve { return Err(FAMILY); }
    let basis = decoder.decode_by_id(axis.ref_at(slot::IfcTrimmedCurve::BASIS_CURVE).ok_or(FAMILY)?).map_err(|_| FAMILY)?;
    let trimmed = decode_trimmed_primitive(&axis, &basis, decoder, TrimRecovery::RequireBoth)
        .map_err(|_| FAMILY)?.ok_or(FAMILY)?;
    match trimmed {
        TrimmedPrimitive::Line { start, end } if start != end => Ok(LayerFamily::Planar { axis: [0., 1., 0.] }),
        TrimmedPrimitive::Circle { center, normal, radius, .. } => {
            let placement = decoder.decode_by_id(basis.ref_at(slot::IfcCircle::POSITION).ok_or(FAMILY)?).map_err(|_| FAMILY)?;
            if rep.string_at(slot::IfcRepresentation::REPRESENTATION_TYPE) != Some("Curve2D") || placement.ifc_type != IfcType::IfcAxis2Placement2D
                || normal != [0., 0., 1.] { return Err(FAMILY); }
            let sigma = if axis.logical_at(slot::IfcTrimmedCurve::SENSE_AGREEMENT).ok_or(FAMILY)? { 1. } else { -1. };
            Ok(LayerFamily::Cylindrical { center: center.map(|v| v * scale), radius: radius * scale, sigma })
        }
        _ => Err(FAMILY),
    }
}
fn line_body(element: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<LayerFamily, &'static str> {
    let shape = product_shape(element, decoder).map_err(|_| FAMILY)?.ok_or(FAMILY)?;
    let rep = shape.select(element, Select::Body).next().ok_or(FAMILY)?;
    let items = rep.get_list(slot::IfcRepresentation::ITEMS.index()).ok_or(FAMILY)?;
    let mut id = items.first().and_then(|v| v.as_entity_ref()).ok_or(FAMILY)?;
    let mut visited = rustc_hash::FxHashSet::default();
    loop {
        crate::resource::budget_checkpoint().map_err(|_| "layer_budget")?;
        if !visited.insert(id) { return Err(FAMILY); }
        let item = decoder.decode_by_id(id).map_err(|_| FAMILY)?;
        if matches!(item.ifc_type, IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult) {
            id = item.ref_at(slot::IfcBooleanResult::FIRST_OPERAND).ok_or(FAMILY)?; continue;
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
