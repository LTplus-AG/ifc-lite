// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one answer to "which curve is this `IfcAlignment`'s directrix?",
//! shared by the alignment processor (`processors/alignment.rs`) and the
//! wasm centerline overlay (`wasm-bindings/src/api/alignment_lines.rs`).
//! Two private copies of this lookup used to exist and could silently
//! disagree about what an alignment's axis is (#5327).

use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType, SchemaVersion};

use crate::representation::{product_shape, rep_items, Select};

/// Where some publishers hang `IfcAlignment.Axis` in a file that does not
/// follow its declared schema: one past the IFC4X1/4X2 position, behind
/// `PredefinedType`. Kept as the one tolerance (F3e D5, #7780) and read only
/// after the declared schema's own `Axis` slot; there is no known conforming
/// writer behind it.
pub(crate) const OFF_SCHEMA_AXIS_SLOT: usize = 8;

/// Resolve an `IfcAlignment`'s directrix curve.
///
/// IFC4X1 and IFC4X2 declare `Axis` (an `IfcCurve`) after `Representation`;
/// IFC4X3 has no such attribute and its slot there is `PredefinedType`, so a
/// 4X3 file is not probed at that position. A file labelled IFC2X3 or IFC4,
/// which predate `IfcAlignment`, is an IFC4X1-draft export and keeps its `Axis`
/// at 7. The declared schema's `Axis` is
/// tried first, then [`OFF_SCHEMA_AXIS_SLOT`] (a publisher that hung it
/// elsewhere), then `Representation` (6), which some publishers reuse. Accept
/// the first ref that resolves to an `IfcAlignmentCurve` or `IfcPolyline`
/// (the curves `AlignmentCurve::parse` understands). A slot probe whose ref
/// fails to resolve is skipped, not fatal.
/// Otherwise IFC4x3 `Representation` (attr 6) supplies the `'Axis'` shape
/// representation's curve (`IfcGradientCurve`; an
/// `IfcSegmentedReferenceCurve` contributes its gradient `BaseCurve`), or
/// the `'FootPrint'` 2D curve when the shape has no usable `'Axis'`. That
/// path refuses rather than skips: a `Representations` member, or an
/// `'Axis'` / `'FootPrint'` representation's `Items`, that does not decode
/// yields `None`, never a curve read past the broken reference.
/// `None` when neither path yields a curve.
pub fn locate_axis_curve(entity: &DecodedEntity, decoder: &mut EntityDecoder) -> Option<DecodedEntity> {
    let alignment_curve = IfcType::from_str("IFCALIGNMENTCURVE");
    let axis = decoder.slot_or(slot::IfcAlignment::AXIS, SchemaVersion::Ifc4x1).map(|slot| slot.index());
    let representation = slot::IfcAlignment::REPRESENTATION.index();
    for idx in axis.into_iter().chain([OFF_SCHEMA_AXIS_SLOT, representation]) {
        let Some(attr) = entity.get(idx) else { continue };
        if attr.is_null() {
            continue;
        }
        if let Ok(Some(resolved)) = decoder.resolve_ref(attr) {
            if resolved.ifc_type == alignment_curve || resolved.ifc_type == IfcType::IfcPolyline {
                return Some(resolved);
            }
        }
    }
    representation_axis_curve(entity, decoder)
}

/// IFC4x3 path of [`locate_axis_curve`]: prefer the `'Axis'` representation
/// (3D, carries the vertical profile) over `'FootPrint'` (plan only).
///
/// Reads the shape through the shared [`product_shape`] walk, so a shape the
/// walk refuses (a `Representations` member or the list itself that does not
/// decode) yields no curve. So do selected `Items` that do not decode, wherever
/// that representation sits in the list: a broken `'Axis'` must not hand the
/// alignment its plan-only `'FootPrint'` (#7781).
fn representation_axis_curve(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<DecodedEntity> {
    let shape = product_shape(entity, decoder).ok().flatten()?;
    let (mut axis, mut footprint) = (None, None);
    for rep in shape.select(entity, Select::Where(is_axis_or_footprint)) {
        let items = rep_items(rep, decoder).ok()?;
        let found = if has_identifier(rep, "AXIS") {
            &mut axis
        } else {
            &mut footprint
        };
        if found.is_none() {
            *found = first_usable_curve(items, decoder);
        }
    }
    axis.or(footprint)
}

/// The first item that is a curve `AlignmentCurve` reads; an
/// `IfcSegmentedReferenceCurve` stands for its `BaseCurve`, and is stepped over
/// when that does not resolve.
fn first_usable_curve(
    items: Vec<DecodedEntity>,
    decoder: &mut EntityDecoder,
) -> Option<DecodedEntity> {
    items.into_iter().find_map(|item| {
        let curve = if item.ifc_type == IfcType::IfcSegmentedReferenceCurve {
            decoder
                .decode_by_id(item.ref_at(slot::IfcSegmentedReferenceCurve::BASE_CURVE)?)
                .ok()?
        } else {
            item
        };
        let usable = matches!(
            curve.ifc_type,
            IfcType::IfcGradientCurve | IfcType::IfcPolyline | IfcType::IfcCompositeCurve
        );
        usable.then_some(curve)
    })
}

/// The representations [`representation_axis_curve`] reads: `'Axis'` or
/// `'FootPrint'` by `RepresentationIdentifier`, in any letter case.
fn is_axis_or_footprint(_: &DecodedEntity, rep: &DecodedEntity, _: Option<&str>) -> bool {
    has_identifier(rep, "AXIS") || has_identifier(rep, "FOOTPRINT")
}

fn has_identifier(rep: &DecodedEntity, identifier: &str) -> bool {
    rep.string_at(slot::IfcRepresentation::REPRESENTATION_IDENTIFIER)
        .is_some_and(|found| found.eq_ignore_ascii_case(identifier))
}
