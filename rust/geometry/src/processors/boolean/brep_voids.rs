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

use super::brep_void_plan::{refuse, void_refs, ReadyVoids, ShellKind, ShellPlan, VoidFault};
use super::BooleanClippingProcessor;
use crate::diagnostics::BoolOp;
use crate::{Mesh, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

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
        let Some(voids) = void_refs(operand) else {
            return (outer, false);
        };
        if outer.is_empty() {
            return (outer, false);
        }
        let refuse = |fault: VoidFault| refuse(self, op, &operand.ifc_type, fault.message());
        let Some(kind) = ShellKind::from_type(&shell_kind) else {
            return refuse(VoidFault::NoShellProcessor);
        };
        let mut void_meshes = Vec::with_capacity(voids.len());
        for value in voids {
            let Some(shell_id) = value.as_entity_ref() else {
                return refuse(VoidFault::NotReference);
            };
            // One shell at a time: an earlier shell that fails to mesh stops
            // before any later shell is read.
            match ShellPlan::lower(shell_id, kind, decoder, quality).and_then(ShellPlan::evaluate) {
                Ok(mesh) if !mesh.is_empty() => void_meshes.push(mesh),
                _ => return refuse(VoidFault::ShellDidNotMesh),
            }
        }
        ReadyVoids::new(void_meshes).subtract(
            outer,
            decoder.length_unit_scale(),
            self,
            op,
            &operand.ifc_type,
        )
    }
}
