// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcFacetedBrepWithVoids` / `IfcAdvancedBrepWithVoids` as a boolean
//! operand (#7786): the solid is its Outer shell minus its Voids.
//!
//! The brep processors mesh attribute 0 (Outer) only, which is right for the
//! item on its own but, as a CUTTER, removes the material the voids leave
//! out: an over-cut, silently. The kernel subtracts the void shells (it
//! orients each operand outward itself, so either authored winding works).

use ifc_lite_core::IfcType;
#[path = "brep_void_plan.rs"]
pub(crate) mod plan;
#[path = "void_evaluation.rs"]
pub(crate) mod void_evaluation;

/// The plain-brep type whose processor meshes one shell given as attribute 0,
/// for a `*BrepWithVoids` type; `None` for every other type.
pub(crate) fn brep_with_voids_shell_kind(ty: &IfcType) -> Option<IfcType> {
    match ty {
        IfcType::IfcFacetedBrepWithVoids => Some(IfcType::IfcFacetedBrep),
        IfcType::IfcAdvancedBrepWithVoids => Some(IfcType::IfcAdvancedBrep),
        _ => None,
    }
}
