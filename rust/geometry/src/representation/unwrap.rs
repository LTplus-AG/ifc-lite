// SPDX-License-Identifier: MPL-2.0
//! #7781: shared iterative wrapper traversal, with caller-specific leaf policy.
use crate::Result;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use rustc_hash::FxHashSet;

pub(crate) enum WrapperPolicy {
    Extrusion { through_booleans: bool, max_nodes: usize },
    // Layer admission must retain arbitrarily long acyclic Boolean chains
    // (#960, #2866), and avoid allocating for an ordinary non-Boolean leaf.
    BooleanLeaf,
}

pub(crate) fn unwrap_item(
    mut current: DecodedEntity,
    decoder: &mut EntityDecoder,
    policy: WrapperPolicy,
    mut step: impl FnMut(&DecodedEntity, &mut EntityDecoder) -> Result<Option<DecodedEntity>>,
) -> Result<Option<DecodedEntity>> {
    let mut remaining = match policy {
        WrapperPolicy::Extrusion { max_nodes, .. } => Some(max_nodes),
        WrapperPolicy::BooleanLeaf => None,
    };
    let mut visited = FxHashSet::default();
    loop {
        if let Some(left) = remaining.as_mut() {
            if *left == 0 { return Ok(None); }
            *left -= 1;
        }
        let boolean = matches!(current.ifc_type,
            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult);
        match policy {
            WrapperPolicy::BooleanLeaf if !boolean => return Ok(Some(current)),
            WrapperPolicy::Extrusion { .. }
                if current.ifc_type == IfcType::IfcExtrudedAreaSolid => return Ok(Some(current)),
            WrapperPolicy::Extrusion { through_booleans, .. }
                if !(current.ifc_type == IfcType::IfcMappedItem || boolean && through_booleans) => {
                return Ok(None);
            }
            _ => {}
        }
        if !visited.insert(current.id) { return Ok(None); }
        let Some(next) = step(&current, decoder)? else { return Ok(None); };
        current = next;
    }
}
