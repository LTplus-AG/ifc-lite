// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Preflight of a `*BrepWithVoids` cutter operand: the ordered void-shell
//! references it carries. Shells are meshed one at a time by the caller, so a
//! later malformed reference is only reached (and refused) after the earlier
//! shells have meshed.

use ifc_lite_core::{slot, DecodedEntity};

/// Ordered `Voids` of one `IfcFacetedBrepWithVoids` / `IfcAdvancedBrepWithVoids`.
#[derive(Debug, Clone)]
pub(super) struct BrepVoidPlan {
    /// One entry per authored void; `None` is a value that is not a shell
    /// reference.
    pub(super) shells: Vec<Option<u32>>,
}

impl BrepVoidPlan {
    /// `None` when the operand has no (or an empty) `Voids` list: its cutter
    /// is its Outer shell as is.
    pub(super) fn read(operand: &DecodedEntity) -> Option<Self> {
        let voids = operand
            .get(slot::IfcFacetedBrepWithVoids::VOIDS.index())
            .and_then(|attr| attr.as_list())?;
        if voids.is_empty() {
            return None;
        }
        Some(Self {
            shells: voids.iter().map(|void| void.as_entity_ref()).collect(),
        })
    }
}
