// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Reached source eligibility and late placement admission.
use crate::math::tol;
use crate::representation::{product_shape, Select};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;
use crate::representation::unwrap::{unwrap_item, WrapperPolicy};

/// Reached only after host production and its empty-mesh test. Use the same
/// placement service and translation scaling as the original layer path.
pub(super) fn admit_frame(
    element: &DecodedEntity,
    decoder: &mut EntityDecoder,
    router: &crate::GeometryRouter,
) -> Option<super::planes::LayerFrame> {
    let mut placement = router
        .get_placement_transform_from_element(element, decoder)
        .ok()?;
    router.scale_transform(&mut placement);
    Some(super::planes::LayerFrame {
        placement,
        unit_scale: router.unit_scale(),
        rtc: router.rtc_offset(),
    })
}

/// True when the element's Body representation has exactly one item and
/// that item carries no additional transform relative to the element's
/// own placement. Only in that case do the layer planes (built from the
/// element placement alone) sit in the same frame as the generated mesh.
///
/// We walk the IfcProductDefinitionShape → IfcShapeRepresentation tree,
/// looking at the first representation that will actually contribute to
/// the Body mesh. Any MappedItem, multi-item list, or item with a
/// non-identity `Position` disqualifies the element from layer slicing.
pub(super) fn element_is_single_unshifted_item(
    element: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> bool {
    let Ok(Some(shape)) = product_shape(element, decoder) else {
        return false;
    };

    // Only body-style representations contribute to the sliced mesh —
    // axis/curve/footprint don't. `Select::Body` is the single canonical
    // body-geometry predicate, so this stays in lockstep with the meshing path
    // (a mapped/surface item disqualifies slicing below regardless, via
    // item_has_identity_position).
    if let Some(shape_rep) = shape.select(element, Select::Body).next() {
        // attr 3 = Items.
        let items = match crate::representation::rep_items_attribute(shape_rep)
            .ok().and_then(|a| a.as_list())
        {
            Some(l) => l,
            None => return false,
        };
        if items.len() != 1 {
            return false;
        }
        let item_id = match items.first().and_then(|v| v.as_entity_ref()) {
            Some(id) => id,
            None => return false,
        };
        let item = match decoder.decode_by_id(item_id) {
            Ok(e) => e,
            Err(_) => return false,
        };

        return item_has_identity_position(item, decoder);
    }

    // No body-style representation found — nothing to slice.
    false
}

/// True when the representation item carries no Position transform (or the
/// Position is the identity). Supports the item types that actually show
/// up with IfcMaterialLayerSetUsage in practice (extrusions, revolved /
/// advanced swept solids, boolean clipping on top of those). Anything
/// exotic returns false so we bail safely.
pub(super) fn item_has_identity_position(
    current: DecodedEntity,
    decoder: &mut EntityDecoder,
) -> bool {
    let leaf = unwrap_item(current, decoder, WrapperPolicy::BooleanLeaf, |item, decoder| {
        let Some(id) = item.get_ref(slot::IfcBooleanResult::FIRST_OPERAND.index()) else {
            return Ok(None);
        };
        Ok(Some(decoder.decode_by_id(id)?))
    });
    match leaf {
        Ok(Some(item)) => item_position_is_identity(&item, decoder),
        _ => false,
    }
}

/// The non-boolean leaf of the [`item_has_identity_position`] walk: does THIS
/// one item's Position resolve to the identity?
fn item_position_is_identity(item: &DecodedEntity, decoder: &mut EntityDecoder) -> bool {
    match item.ifc_type {
        // Solid primitives with a Position at attribute 1.
        IfcType::IfcExtrudedAreaSolid
        | IfcType::IfcRevolvedAreaSolid
        | IfcType::IfcSurfaceCurveSweptAreaSolid
        | IfcType::IfcFixedReferenceSweptAreaSolid => {
            attribute_placement_is_identity(item, 1, decoder)
        }
        // MappedItem applies a target transform by definition — always bail.
        IfcType::IfcMappedItem => false,
        // Tessellated / Brep / surface-model items have no Position
        // attribute; the mesh already sits in the element's local frame.
        IfcType::IfcFacetedBrep
        | IfcType::IfcFacetedBrepWithVoids
        | IfcType::IfcAdvancedBrep
        | IfcType::IfcAdvancedBrepWithVoids
        | IfcType::IfcTriangulatedFaceSet
        | IfcType::IfcTriangulatedIrregularNetwork
        | IfcType::IfcPolygonalFaceSet
        | IfcType::IfcFaceBasedSurfaceModel
        | IfcType::IfcShellBasedSurfaceModel => true,
        _ => false,
    }
}

/// Resolve a placement attribute and compare the resulting 4×4 to the
/// identity matrix within a small tolerance. Returns true when the
/// attribute is absent (treated as implicit identity).
fn attribute_placement_is_identity(
    entity: &DecodedEntity,
    attr_index: usize,
    decoder: &mut EntityDecoder,
) -> bool {
    let attr = match entity.get(attr_index) {
        Some(a) => a,
        None => return true,
    };
    if attr.is_null() {
        return true;
    }
    let placement_id = match attr.as_entity_ref() {
        Some(id) => id,
        None => return false,
    };
    match crate::placement::Axis2Placement::read_id(placement_id, decoder) {
        Ok(placement) => matrix_is_identity(&placement.matrix()),
        Err(_) => false,
    }
}

#[inline]
fn matrix_is_identity(m: &Matrix4<f64>) -> bool {
    let id = Matrix4::<f64>::identity();
    for i in 0..4 {
        for j in 0..4 {
            if (m[(i, j)] - id[(i, j)]).abs() > tol::IDENTITY_EPS {
                return false;
            }
        }
    }
    true
}
