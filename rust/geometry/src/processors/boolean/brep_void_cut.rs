// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Numerical half of a `*BrepWithVoids` cutter: owned Outer and void-shell
//! meshes in, a verdict out. The caller owns the diagnostic records.

use crate::diagnostics::BoolFailure;
use crate::{ClippingProcessor, GroupCut, GroupReject, Mesh};

pub(super) enum VoidCut {
    /// No void reaches the Outer solid: the cutter IS its Outer shell.
    Keep,
    /// The Outer solid minus its voids, with the kernel failures it recorded.
    Hollow {
        mesh: Mesh,
        failures: Vec<BoolFailure>,
    },
    /// The cutter is refused (ONE record: the kernel's own failures are
    /// dropped, not counted twice). Carries the reason.
    Refuse(String),
}

/// Subtract the ordered void meshes from `outer`. The kernel orients each
/// operand outward itself, so either authored winding works.
pub(super) fn subtract_voids(outer: &Mesh, voids: &[Mesh], length_unit_scale: f64) -> VoidCut {
    let clipper = ClippingProcessor::with_unit_scale(length_unit_scale);
    let refs: Vec<&Mesh> = voids.iter().collect();
    match clipper.subtract_mesh_many(outer, &refs) {
        GroupCut::Rejected(GroupReject::NoOverlap | GroupReject::Unchanged) => VoidCut::Keep,
        GroupCut::Cut(hollow) | GroupCut::Retessellated(hollow) if !hollow.is_empty() => {
            VoidCut::Hollow {
                mesh: hollow,
                failures: clipper.take_failures(),
            }
        }
        GroupCut::Rejected(reject) => {
            let _ = clipper.take_failures();
            VoidCut::Refuse(format!("subtract rejected ({reject:?})"))
        }
        // The voids engulf the Outer: nothing is left to cut with.
        GroupCut::Cut(_) | GroupCut::Retessellated(_) => {
            let _ = clipper.take_failures();
            VoidCut::Refuse("voids engulf the outer shell".to_string())
        }
    }
}
