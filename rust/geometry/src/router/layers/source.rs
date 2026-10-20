// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Reached source eligibility and late placement admission.
use crate::math::tol;
use crate::representation::{product_shape, Select};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;
use rustc_hash::FxHashSet;

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
        let items = match shape_rep
            .get(slot::IfcRepresentation::ITEMS.index())
            .and_then(|a| a.as_list())
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
    mut cur: DecodedEntity,
    decoder: &mut EntityDecoder,
) -> bool {
    // `IfcBooleanResult.FirstOperand` is a file-supplied reference, so
    // `#10=IFCBOOLEANRESULT(.DIFFERENCE.,#10,#20)` -- one self-referential
    // entity -- walked forever. This walk used to RECURSE, so it consumed a
    // stack frame per link and aborted the process; a Rust stack overflow
    // ABORTS rather than raising a catchable panic, so nothing could turn it
    // into a load error (#2866).
    //
    // Iterative plus a visited-id set, the same shape as `collect_polygonal_chain`
    // in processors/boolean/mod.rs. Iterating is what makes the set SUFFICIENT:
    // it breaks on the first repeat, and with no stack to consume there is
    // nothing left for a length cap to protect. Capping length INSTEAD of
    // iterating would reintroduce the regression #960 made that walk iterative
    // to fix: Revit exports building-element-part chains up to 42 DIFFERENCE
    // nodes deep, and bailing on one returns `false`, so a wall that renders
    // with layer slicing today would silently render as a single mesh.
    let mut visited: FxHashSet<u32> = FxHashSet::default();
    loop {
        // Type check BEFORE the insert: the walk only ever descends FROM a
        // boolean node, so every node on a reachable cycle is one, and a plain
        // extrusion -- the overwhelmingly common root -- reaches its answer
        // without the set ever allocating.
        if !matches!(
            cur.ifc_type,
            IfcType::IfcBooleanClippingResult | IfcType::IfcBooleanResult
        ) {
            return item_position_is_identity(&cur, decoder);
        }
        // A repeat is "exotic", which this function's contract already answers
        // with `false`.
        if !visited.insert(cur.id) {
            return false;
        }
        // Boolean results wrap another operand; follow the first operand,
        // which carries the visible geometry.
        let Some(first_operand_id) = cur.get_ref(slot::IfcBooleanResult::FIRST_OPERAND.index())
        else {
            return false;
        };
        cur = match decoder.decode_by_id(first_operand_id) {
            Ok(inner) => inner,
            Err(_) => return false,
        };
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
    match crate::transform::parse_axis2_placement_3d_from_id(placement_id, decoder) {
        Ok(m) => matrix_is_identity(&m),
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
