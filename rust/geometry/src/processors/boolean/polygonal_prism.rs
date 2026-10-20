// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::bounded_prism_plan::BoundedPrismPlan;
use super::BooleanClippingProcessor;
use crate::{
    ClippingProcessor, GroupCut, GroupReject, Mesh, Point3, Result, TessellationQuality, Vector3,
};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

impl BooleanClippingProcessor {
    pub(super) fn build_polygonal_bounded_half_space_mesh(
        &self,
        half_space: &DecodedEntity,
        decoder: &mut EntityDecoder,
        host_mesh: &Mesh,
        plane: (Point3<f64>, Vector3<f64>, bool),
        quality: TessellationQuality,
    ) -> Result<Option<Mesh>> {
        let Some(plan) = BoundedPrismPlan::lower(self, half_space, decoder, quality)? else {
            return Ok(None);
        };
        plan.build_mesh(host_mesh, plane).map(Some)
    }

    /// Subtract `cutter` from `base`; an accept-gate rejection (#3919) is `None`
    /// like an empty or degenerate result, and any other rejection hands `base`
    /// back un-cut. Used by `cut_polygonal_chain`'s per-cutter trials and
    /// final subtract so a rejected gate always defers to the sequential path.
    /// Leaves any failures in `clipper` for the caller to drain.
    pub(super) fn subtract_checked(
        clipper: &ClippingProcessor,
        base: &Mesh,
        cutter: &Mesh,
    ) -> Option<Mesh> {
        let m = match clipper.subtract_operand(base, cutter) {
            GroupCut::Rejected(GroupReject::GateRejected) => return None,
            outcome => outcome.into_mesh(),
        };
        let checked = m.as_ref().unwrap_or(base);
        (!checked.is_empty() && !ClippingProcessor::difference_result_looks_degenerate(base, checked))
            .then(|| m.unwrap_or_else(|| base.clone()))
    }
}

/// True when every host vertex lies on the kept side of the half-space plane or
/// on it. A host that never reaches the removed side loses nothing, and a prism
/// whose base cap is coplanar with the host's own face (a wall clipped at its
/// own top) only hands the kernel a coplanar cut that tears it (census #63466,
/// #7762) (within a relative `1e-6` of the host's extent). `agreement` puts the
/// removed material on the negative normal side, as in the prism builder.
pub(super) fn host_stays_on_kept_side(
    mesh: &Mesh,
    plane_point: Point3<f64>,
    plane_normal: Vector3<f64>,
    agreement: bool,
) -> bool {
    let Some(normal) = plane_normal.try_normalize(1e-12) else { return false };
    let removed = if agreement { -normal } else { normal };
    let (lo, hi) = mesh.bounds();
    let extent = ((hi.x - lo.x) as f64).hypot((hi.y - lo.y) as f64).hypot((hi.z - lo.z) as f64);
    let eps = 1e-6 * extent.max(1.0);
    !mesh.positions.is_empty()
        && mesh.positions.chunks_exact(3).all(|p| {
            let v = Point3::new(p[0] as f64, p[1] as f64, p[2] as f64) - plane_point;
            v.dot(&removed) <= eps
        })
}
