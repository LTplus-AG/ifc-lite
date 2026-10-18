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

use super::BooleanClippingProcessor;
use crate::{BoolOp, Mesh, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
#[path = "brep_void_plan.rs"]
pub(crate) mod plan;
#[path = "void_evaluation.rs"]
pub(crate) mod void_evaluation;
use plan::{ShellKind, ShellPlan, VoidFault};

/// The plain-brep type whose processor meshes one shell given as attribute 0,
/// for a `*BrepWithVoids` type; `None` for every other type.
pub(super) fn brep_with_voids_shell_kind(ty: &IfcType) -> Option<IfcType> {
    match ty {
        IfcType::IfcFacetedBrepWithVoids => Some(IfcType::IfcFacetedBrep),
        IfcType::IfcAdvancedBrepWithVoids => Some(IfcType::IfcAdvancedBrep),
        _ => None,
    }
}

impl BooleanClippingProcessor {
    /// `outer` minus the operand's Voids (attribute 1), as a cutter for `op`.
    ///
    /// A void that cannot be meshed, or a subtract the kernel rejects, REFUSES
    /// the operand (empty mesh, ONE record, so the host stays uncut) rather
    /// than falling back to the Outer shell: that is the over-cut this exists
    /// to prevent (D3, fail closed with a counter). Voids that miss the Outer
    /// solid leave it as is: nothing to subtract, nothing refused.
    pub(super) fn without_voids(
        &self,
        shell_kind: IfcType,
        op: BoolOp,
        operand: &DecodedEntity,
        outer: Mesh,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
    ) -> (Mesh, bool) {
        let Some(voids) = plan::void_refs(operand) else { return (outer, false); };
        if voids.is_empty() || outer.is_empty() { return (outer, false); }
        let Some(kind) = ShellKind::from_type(&shell_kind) else {
            return void_evaluation::refuse(self, op, &operand.ifc_type, VoidFault::NoProcessor.message());
        };
        let mut meshes = Vec::with_capacity(voids.len());
        // Admission remains conditional in production: an empty earlier shell
        // prevents every later shell reference and its reports from being read.
        for value in voids {
            let Some(id) = value.as_entity_ref() else {
                return void_evaluation::refuse(self, op, &operand.ifc_type, VoidFault::NotReference.message());
            };
            match ShellPlan::lower(id, kind, decoder, quality).and_then(ShellPlan::evaluate) {
                Ok(mesh) if !mesh.is_empty() => meshes.push(mesh),
                _ => return void_evaluation::refuse(self, op, &operand.ifc_type, VoidFault::ShellDidNotMesh.message()),
            }
        }
        // Keep unit discovery after all shells have meshed nonempty, exactly
        // where production needs the group-cut numerical policy.
        let scale = decoder.length_unit_scale();
        void_evaluation::ReadyVoids::new(meshes).subtract(outer, scale, self, op, &operand.ifc_type)
    }
}
