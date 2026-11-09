// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The per-product representation walk behind `extract_symbolic_data`.

use super::fill_provenance;
use super::item_walk::extract_symbolic_item;
use super::output_cap::SymbolicAccumulator;
use super::rebase::RenderFrameRebase;
use super::transform::{self, compose_transforms, resolve_object_placement};
use ifc_lite_core::{slot, EntityDecoder, IfcType};

/// Emit the symbols of one Plan / Annotation / FootPrint / Axis
/// `IfcShapeRepresentation` whose items sit in the frame `base`.
#[allow(clippy::too_many_arguments)]
pub(super) fn emit_shape_representation(
    shape_rep: &ifc_lite_core::DecodedEntity,
    rep_identifier: &str,
    base: &transform::Transform2D,
    single_representation: bool,
    express_id: u32,
    ifc_type_name: &str,
    decoder: &mut EntityDecoder,
    unit_scale: f64,
    rebase: RenderFrameRebase,
    styled_items: &std::collections::HashMap<u32, Vec<u32>>,
    out: &mut SymbolicAccumulator,
) {
    let Some(items_attr) = shape_rep.attr(slot::IfcShapeRepresentation::ITEMS) else {
        return;
    };
    let Ok(items) = decoder.resolve_ref_list(items_attr) else {
        return;
    };
    let direct_fill_ids = fill_provenance::direct_fill_ids(&items, single_representation);
    for item in items {
        if out.is_exhausted() {
            break;
        }
        extract_symbolic_item(
            &item,
            decoder,
            express_id,
            ifc_type_name,
            rep_identifier,
            unit_scale,
            base,
            rebase,
            styled_items,
            out,
            direct_fill_ids.contains(&item.id).then_some(item.id),
        );
    }
}

/// Walk the product's own `Representation`. Returns whether it carries a
/// symbolic (Plan / Annotation / FootPrint / Axis) representation, whether or
/// not any item yielded output: that decides if the type is consulted.
#[allow(clippy::too_many_arguments)]
pub(super) fn walk_own_representations(
    entity: &ifc_lite_core::DecodedEntity,
    id: u32,
    ifc_type_name: &str,
    decoder: &mut EntityDecoder,
    unit_scale: f64,
    rebase: RenderFrameRebase,
    styled_items: &std::collections::HashMap<u32, Vec<u32>>,
    out: &mut SymbolicAccumulator,
) -> bool {
    let Some(representation_attr) = entity.attr(slot::IfcProduct::REPRESENTATION) else {
        return false;
    };
    if representation_attr.is_null() {
        return false;
    }
    let Ok(Some(representation)) = decoder.resolve_ref(representation_attr) else {
        return false;
    };
    let Some(reps_attr) = representation.attr(slot::IfcProductDefinitionShape::REPRESENTATIONS) else {
        return false;
    };
    let Ok(representations) = decoder.resolve_ref_list(reps_attr) else {
        return false;
    };

    let mut has_symbolic = false;
    let single_representation = representations.len() == 1;
    for shape_rep in representations {
        if out.is_exhausted() { break; }
        if shape_rep.ifc_type != IfcType::IfcShapeRepresentation {
            continue;
        }
        let rep_identifier = shape_rep
            .string_at(slot::IfcShapeRepresentation::REPRESENTATION_IDENTIFIER)
            .unwrap_or("");
        if !is_symbolic_identifier(rep_identifier) {
            continue;
        }
        has_symbolic = true;

        // Retain the shared 3D ObjectPlacement frame until plan projection.
        let placement_transform = resolve_object_placement(entity, decoder, unit_scale);

        let context_transform = transform::resolve_context_transform(&shape_rep, decoder, unit_scale);
        // A small 3D WCS rotation can couple a large local Z into plan
        // XY. Compose before projection without an approximate identity
        // shortcut, even when its XY block appears unchanged (#7779).
        let combined_transform = compose_transforms(&context_transform, &placement_transform);
        emit_shape_representation(
            &shape_rep,
            rep_identifier,
            &combined_transform,
            single_representation,
            id,
            ifc_type_name,
            decoder,
            unit_scale,
            rebase,
            styled_items,
            out,
        );
    }
    has_symbolic
}

pub(super) fn is_symbolic_identifier(rep_identifier: &str) -> bool {
    matches!(rep_identifier, "Plan" | "Annotation" | "FootPrint" | "Axis")
}
