// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one answer to "which curve is this `IfcAlignment`'s directrix?",
//! shared by the alignment processor (`processors/alignment.rs`) and the
//! wasm centerline overlay (`wasm-bindings/src/api/alignment_lines.rs`).
//! Two private copies of this lookup used to exist and could silently
//! disagree about what an alignment's axis is (#5327).

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

/// Resolve an `IfcAlignment`'s directrix curve.
///
/// IFC4X1 puts `Axis` at attribute 7; some publishers reuse `Representation`
/// (6) or hang it at 8. Accept the first ref that resolves to an
/// `IfcAlignmentCurve` or `IfcPolyline` (the curves `AlignmentCurve::parse`
/// understands). A ref that fails to resolve is skipped, not fatal.
/// Otherwise IFC4x3 `Representation` (attr 6) supplies the `'Axis'` shape
/// representation's curve (`IfcGradientCurve`; an
/// `IfcSegmentedReferenceCurve` contributes its gradient `BaseCurve`), or
/// the `'FootPrint'` 2D curve. `None` when neither path yields a curve.
pub fn locate_axis_curve(entity: &DecodedEntity, decoder: &mut EntityDecoder) -> Option<DecodedEntity> {
    let alignment_curve = IfcType::from_str("IFCALIGNMENTCURVE");
    for idx in [7usize, 8, 6] {
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
fn representation_axis_curve(entity: &DecodedEntity, decoder: &mut EntityDecoder) -> Option<DecodedEntity> {
    let shape = decoder.decode_by_id(entity.get_ref(6)?).ok()?;
    if shape.ifc_type != IfcType::IfcProductDefinitionShape {
        return None;
    }
    let mut footprint = None;
    for rep_id in shape.get_refs(2)? {
        let Ok(rep) = decoder.decode_by_id(rep_id) else { continue };
        let identifier = rep.get(1).and_then(|v| v.as_string()).unwrap_or("").to_ascii_uppercase();
        for item_id in rep.get_refs(3).unwrap_or_default() {
            let Ok(item) = decoder.decode_by_id(item_id) else { continue };
            let curve = if item.ifc_type == IfcType::IfcSegmentedReferenceCurve {
                // IfcSegmentedReferenceCurve: 0 Segments, 1 SelfIntersect, 2 BaseCurve
                match item.get_ref(2).and_then(|id| decoder.decode_by_id(id).ok()) {
                    Some(base) => base,
                    None => continue,
                }
            } else {
                item
            };
            let usable = matches!(
                curve.ifc_type,
                IfcType::IfcGradientCurve | IfcType::IfcPolyline | IfcType::IfcCompositeCurve
            );
            if !usable {
                continue;
            }
            if identifier == "AXIS" {
                return Some(curve);
            }
            if identifier == "FOOTPRINT" && footprint.is_none() {
                footprint = Some(curve);
            }
        }
    }
    footprint
}
